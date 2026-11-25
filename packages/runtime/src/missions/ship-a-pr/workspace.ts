import { createHash } from "node:crypto";
import { posix } from "node:path";

import { type RunContext } from "../../agent/context";
import { type SandboxCommandPurpose, type TestRunSummary } from "../../events";
import { type FileChange, type FileMode } from "../../github/app";
import {
  SandboxPathError,
  confinePath,
  isProtectedPath,
  normaliseRepoPath,
} from "../../sandbox/paths";
import { type ExecResult, type Sandbox } from "../../sandbox/types";
import { PROJECT_MARKER_FILES, type ProjectCommand, type ProjectFiles } from "./detect";
import { DIFF_LIMITS, type DiffContent, type DiffFile, type RepoDiff } from "./schema";

export { DIFF_LIMITS };

export const SHIP_TIMEOUTS = {
  gitMs: 60_000,
  cloneMs: 120_000,
  installMs: 240_000,
  testMs: 180_000,
  toolMs: 120_000,
} as const;

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /nvapi-[A-Za-z0-9_-]{10,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/g,
];

export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0;
  let output = text;
  for (const pattern of SECRET_PATTERNS)
    output = output.replace(pattern, () => {
      count += 1;
      return "[redacted:secret]";
    });
  return { text: output, count };
}

export interface CommandRun extends ExecResult {
  label: string;
  output: string;
}

export function commandSummary(run: CommandRun | null): TestRunSummary {
  if (run === null) return { command: null, exitCode: null, passed: null, durationMs: 0 };
  return {
    command: run.label.slice(0, 500),
    exitCode: run.exitCode,
    passed: run.exitCode === 0,
    durationMs: Math.max(0, Math.round(run.durationMs)),
    ...(run.timedOut ? { timedOut: true } : {}),
  };
}

export async function runInSandbox(
  ctx: RunContext,
  sandbox: Sandbox,
  options: {
    stepId: string;
    purpose: SandboxCommandPurpose;
    argv: readonly string[];
    timeoutMs: number;
    in?: "repo" | "workdir";
    label?: string;
  },
): Promise<CommandRun> {
  const [cmd, ...args] = options.argv;
  if (cmd === undefined) throw new Error("Empty command");
  const result = await sandbox.exec({
    cmd,
    args,
    timeoutMs: options.timeoutMs,
    ...(options.in === undefined ? {} : { in: options.in }),
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  });
  const label = (options.label ?? options.argv.join(" ")).slice(0, 500);
  const combined = [result.stdout, result.stderr].filter((part) => part !== "").join("\n");
  const redacted = redactSecrets(combined);
  const tail =
    redacted.text.length > DIFF_LIMITS.commandOutputChars
      ? redacted.text.slice(redacted.text.length - DIFF_LIMITS.commandOutputChars)
      : redacted.text;
  await ctx.emitter.emit({
    runId: ctx.runId,
    type: "sandbox.command",
    stepId: options.stepId,
    payload: {
      commandId: ctx.nextId("cmd"),
      purpose: options.purpose,
      command: label,
      exitCode: result.exitCode,
      durationMs: Math.max(0, Math.round(result.durationMs)),
      timedOut: result.timedOut,
      output: tail,
      truncated: result.truncated || tail.length < redacted.text.length,
      ...(redacted.count === 0 ? {} : { redactions: redacted.count }),
    },
  });
  return { ...result, label, output: tail };
}

export async function runProjectCommand(
  ctx: RunContext,
  sandbox: Sandbox,
  stepId: string,
  purpose: SandboxCommandPurpose,
  command: ProjectCommand,
  timeoutMs: number,
): Promise<CommandRun> {
  return runInSandbox(ctx, sandbox, { stepId, purpose, argv: command.argv, timeoutMs });
}

export class WorkspaceError extends Error {
  override readonly name = "WorkspaceError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface CloneSource {
  url: string;
  ref?: string;
}

export async function cloneRepository(
  ctx: RunContext,
  sandbox: Sandbox,
  stepId: string,
  source: CloneSource,
): Promise<string> {
  const https = source.url.startsWith("https://");
  const git = (args: string[], timeoutMs: number = SHIP_TIMEOUTS.gitMs, label?: string) =>
    runInSandbox(ctx, sandbox, {
      stepId,
      purpose: "clone",
      argv: [
        "git",
        ...(https ? ["-c", "protocol.allow=never", "-c", "protocol.https.allow=always"] : []),
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      timeoutMs,
      in: "workdir",
      ...(label === undefined ? {} : { label }),
    });
  const must = (run: CommandRun, what: string) => {
    if (run.exitCode !== 0)
      throw new WorkspaceError(
        "clone_failed",
        `${what} failed${run.timedOut ? " (timed out)" : ""}: ${run.output.slice(-300)}`,
      );
  };
  must(await git(["init", "-q", "repo"]), "git init");
  must(await git(["-C", "repo", "remote", "add", "origin", source.url]), "git remote add");
  must(
    await git(
      ["-C", "repo", "fetch", "--depth", "1", "--no-tags", "origin", source.ref ?? "HEAD"],
      SHIP_TIMEOUTS.cloneMs,
      `git fetch --depth 1 origin ${source.ref ?? "HEAD"}`,
    ),
    "git fetch",
  );
  must(await git(["-C", "repo", "checkout", "-q", "--detach", "FETCH_HEAD"]), "git checkout");
  const head = await git(["-C", "repo", "rev-parse", "HEAD"]);
  must(head, "git rev-parse");
  const sha = head.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(sha))
    throw new WorkspaceError("clone_failed", "Could not read the cloned commit");
  return sha;
}

export async function readProjectFiles(sandbox: Sandbox): Promise<ProjectFiles> {
  const present = new Set<string>();
  const texts: Partial<Record<string, string>> = {};
  for (const name of PROJECT_MARKER_FILES) {
    const target = await confinePath(sandbox, name, "read").catch(() => null);
    if (target === null) continue;
    const content = await sandbox.readFile(target.absolute, 512_000);
    if (content === null) continue;
    present.add(name);
    if (name === "package.json" || name === "pyproject.toml" || name === "Makefile")
      texts[name] = new TextDecoder().decode(content);
  }
  return {
    present,
    ...(texts["package.json"] === undefined ? {} : { packageJson: texts["package.json"] }),
    ...(texts["pyproject.toml"] === undefined ? {} : { pyproject: texts["pyproject.toml"] }),
    ...(texts.Makefile === undefined ? {} : { makefile: texts.Makefile }),
  };
}

function gitRun(ctx: RunContext, sandbox: Sandbox, stepId: string, args: string[]) {
  return runInSandbox(ctx, sandbox, {
    stepId,
    purpose: "diff",
    argv: ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.quotePath=false", ...args],
    timeoutMs: SHIP_TIMEOUTS.gitMs,
  });
}

async function gitOutput(sandbox: Sandbox, args: string[]): Promise<string> {
  const result = await sandbox.exec({
    cmd: "git",
    args: ["-c", "core.hooksPath=/dev/null", "-c", "core.quotePath=false", ...args],
    timeoutMs: SHIP_TIMEOUTS.gitMs,
  });
  if (result.exitCode !== 0 || result.truncated)
    throw new WorkspaceError("diff_failed", `git ${args[0] ?? ""} failed`);
  return result.stdout;
}

export class DiffRejectedError extends WorkspaceError {
  constructor(message: string) {
    super("diff_rejected", message);
  }
}

export async function snapshotTree(sandbox: Sandbox): Promise<string> {
  await gitOutput(sandbox, ["add", "-A"]);
  const tree = (await gitOutput(sandbox, ["write-tree"])).trim();
  if (!/^[0-9a-f]{40}$/.test(tree))
    throw new WorkspaceError("snapshot_failed", "Could not record the installed tree");
  return tree;
}

function gitBlobId(content: Uint8Array): string {
  return createHash("sha1").update(`blob ${content.byteLength}\0`).update(content).digest("hex");
}

export function sha256Hex(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

async function readChangedFile(
  sandbox: Sandbox,
  root: string,
  path: string,
  blobId: string,
): Promise<Uint8Array> {
  const absolute = posix.join(root, path);
  if ((await sandbox.resolve(absolute)) !== absolute)
    throw new DiffRejectedError(`${path} is a link`);
  const content = await sandbox.readFile(absolute, DIFF_LIMITS.maxFileBytes + 1);
  if (content === null) throw new DiffRejectedError(`${path} is missing`);
  if (content.byteLength > DIFF_LIMITS.maxFileBytes)
    throw new DiffRejectedError(`${path} is larger than the file cap`);
  if (gitBlobId(content) !== blobId)
    throw new DiffRejectedError(`${path} changed while the diff was being recorded`);
  return content;
}

export async function collectDiff(
  ctx: RunContext,
  sandbox: Sandbox,
  stepId: string,
  baseSha: string,
  baselineTree: string,
): Promise<RepoDiff> {
  const staged = await gitRun(ctx, sandbox, stepId, ["add", "-A"]);
  if (staged.exitCode !== 0) throw new WorkspaceError("diff_failed", "git add failed");
  const tree = (await gitOutput(sandbox, ["write-tree"])).trim();
  if (!/^[0-9a-f]{40}$/.test(tree))
    throw new WorkspaceError("diff_failed", "Could not record the changed tree");
  const diffArgs = ["diff", "--no-renames"];
  const raw = await gitOutput(sandbox, [
    ...diffArgs,
    "--raw",
    "--no-abbrev",
    "-z",
    baselineTree,
    tree,
  ]);
  const numstat = await gitOutput(sandbox, [...diffArgs, "--numstat", "-z", baselineTree, tree]);
  const patch = await gitOutput(sandbox, [...diffArgs, "--binary", baselineTree, tree]);
  if (new TextEncoder().encode(patch).byteLength > DIFF_LIMITS.maxPatchBytes)
    throw new DiffRejectedError(
      `The change is larger than ${Math.round(DIFF_LIMITS.maxPatchBytes / 1000)} KB`,
    );
  const counts = new Map<string, { additions: number; deletions: number }>();
  const numParts = numstat.split("\0").filter((part) => part !== "");
  for (const part of numParts) {
    const [added = "0", deleted = "0", ...rest] = part.split("\t");
    const path = rest.join("\t");
    counts.set(path, {
      additions: Number.parseInt(added, 10) || 0,
      deletions: Number.parseInt(deleted, 10) || 0,
    });
  }
  const parts = raw.split("\0");
  const files: DiffFile[] = [];
  const blobs: { path: string; blobId: string }[] = [];
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const meta = parts[index] ?? "";
    const path = parts[index + 1] ?? "";
    if (meta === "" || path === "") continue;
    const [, newMode = "", , newBlob = "", status = ""] = meta.replace(/^:/, "").split(" ");
    const kind = status.startsWith("A") ? "added" : status.startsWith("D") ? "deleted" : "modified";
    let relative: string;
    try {
      relative = normaliseRepoPath(path);
    } catch (error) {
      throw new DiffRejectedError(
        error instanceof SandboxPathError ? `${path}: ${error.message}` : `${path} is not allowed`,
      );
    }
    if (isProtectedPath(relative))
      throw new DiffRejectedError(`${relative} is a CI or repository configuration file`);
    const mode: FileMode | null =
      kind === "deleted" ? "100644" : newMode === "100644" || newMode === "100755" ? newMode : null;
    if (mode === null)
      throw new DiffRejectedError(`${relative} is a symlink or submodule (mode ${newMode})`);
    if (kind !== "deleted") {
      if (!/^[0-9a-f]{40}$/.test(newBlob))
        throw new WorkspaceError("diff_failed", `Could not read the blob id of ${relative}`);
      blobs.push({ path: relative, blobId: newBlob });
    }
    const count = counts.get(path) ?? { additions: 0, deletions: 0 };
    files.push({ path: relative, status: kind, mode, ...count });
  }
  if (files.length > DIFF_LIMITS.maxFiles)
    throw new DiffRejectedError(`The change touches more than ${DIFF_LIMITS.maxFiles} files`);
  const root = await sandbox.resolve(sandbox.repoDir);
  const contents: DiffContent[] = [];
  let total = 0;
  for (const blob of blobs) {
    const content = await readChangedFile(sandbox, root, blob.path, blob.blobId);
    total += content.byteLength;
    if (total > DIFF_LIMITS.maxContentBytes)
      throw new DiffRejectedError(
        `The changed files are larger than ${Math.round(DIFF_LIMITS.maxContentBytes / 1000)} KB in total`,
      );
    contents.push({
      path: blob.path,
      sha256: sha256Hex(content),
      base64: Buffer.from(content).toString("base64"),
    });
  }
  return {
    baseSha,
    patch,
    files,
    contents,
    stat: {
      files: files.length,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    },
  };
}

export function approvedFileChanges(diff: RepoDiff): FileChange[] {
  if (diff.contents === undefined)
    throw new DiffRejectedError("The approved diff carries no pinned file contents");
  const pinned = new Map(diff.contents.map((entry) => [entry.path, entry]));
  return diff.files.map((file): FileChange => {
    if (file.status === "deleted") return { path: file.path, mode: file.mode, content: null };
    const entry = pinned.get(file.path);
    if (entry === undefined) throw new DiffRejectedError(`${file.path} has no approved content`);
    const content = new Uint8Array(Buffer.from(entry.base64, "base64"));
    if (content.byteLength > DIFF_LIMITS.maxFileBytes)
      throw new DiffRejectedError(`${file.path} is larger than the file cap`);
    if (sha256Hex(content) !== entry.sha256)
      throw new DiffRejectedError(`${file.path} does not match its approved SHA-256`);
    return { path: file.path, mode: file.mode, content };
  });
}

export async function applyRecordedPatch(
  ctx: RunContext,
  sandbox: Sandbox,
  stepId: string,
  patch: string,
): Promise<void> {
  if (patch.trim() === "") return;
  const file = posix.join(sandbox.workdir, "delegate-resume.patch");
  await sandbox.writeFile(file, new TextEncoder().encode(patch));
  const applied = await gitRun(ctx, sandbox, stepId, ["apply", "--binary", "--index", file]);
  if (applied.exitCode !== 0)
    throw new WorkspaceError("resume_failed", "The recorded patch no longer applies");
}
