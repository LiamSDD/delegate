import {
  type RunEvent,
  type SandboxCommandPurpose,
  ShipDiffSchema,
  type ShipDiff,
  type ShipApprovalState,
  ShipResultSchema,
  type ShipResult,
  ShipTestReportSchema,
  type ShipTestReport,
  ShipWorkspaceSchema,
  type ShipWorkspace,
  type PullRequestOpenedPayload,
  SHIP_DIFF_KIND,
  SHIP_RESULT_KIND,
  SHIP_TEST_REPORT_KIND,
  SHIP_WORKSPACE_KIND,
  foldRun,
} from "@delegate/runtime";
import { type z } from "zod";

export interface ShipCommandView {
  key: string;
  seq: number;
  stepId: string;
  purpose: SandboxCommandPurpose;
  command: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  output: string;
  truncated: boolean;
  at: string;
}

export interface ShipView {
  repo: string | null;
  title: string | null;
  acceptance: string[];
  commands: ShipCommandView[];
  workspace: ShipWorkspace | null;
  baseline: ShipTestReport | null;
  after: ShipTestReport | null;
  diff: ShipDiff | null;
  approval: ShipApprovalState | null;
  result: ShipResult | null;
  pullRequest: PullRequestOpenedPayload | null;
}

interface ArtifactRecord {
  kind: string;
  stepId: string | undefined;
  content: unknown;
  seq: number;
}

function artifacts(events: readonly RunEvent[]): ArtifactRecord[] {
  const byId = new Map<string, ArtifactRecord>();
  for (const event of events) {
    if (event.type === "artifact.created")
      byId.set(event.payload.artifactId, {
        kind: event.payload.kind,
        stepId: event.stepId,
        content: event.payload.content,
        seq: event.seq,
      });
    if (event.type === "artifact.updated") {
      const known = byId.get(event.payload.artifactId);
      if (known !== undefined && event.payload.content !== undefined)
        byId.set(event.payload.artifactId, {
          ...known,
          content: event.payload.content,
          seq: event.seq,
        });
    }
  }
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

function latest<T>(
  records: readonly ArtifactRecord[],
  kind: string,
  schema: z.ZodType<T>,
  stepId?: string,
): T | null {
  const match = records
    .filter((record) => record.kind === kind && (stepId === undefined || record.stepId === stepId))
    .at(-1);
  if (match === undefined) return null;
  const parsed = schema.safeParse(match.content);
  return parsed.success ? parsed.data : null;
}

function repoName(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match === null ? null : `${match[1] ?? ""}/${match[2] ?? ""}`;
}

function improvementOf(input: Record<string, unknown>): {
  title: string | null;
  acceptance: string[];
} {
  const improvement = input.improvement;
  if (typeof improvement !== "object" || improvement === null)
    return { title: null, acceptance: [] };
  const record = improvement as Record<string, unknown>;
  return {
    title: typeof record.title === "string" ? record.title : null,
    acceptance: Array.isArray(record.acceptance)
      ? record.acceptance.filter((item): item is string => typeof item === "string")
      : [],
  };
}

export function buildShipView(events: readonly RunEvent[]): ShipView {
  const created = events[0];
  const input = created?.type === "run.created" ? created.payload.input : {};
  const records = artifacts(events);
  let state: ReturnType<typeof foldRun> | null;
  try {
    state = events.length === 0 ? null : foldRun(events);
  } catch {
    state = null;
  }
  const commands = events.flatMap((event): ShipCommandView[] =>
    event.type === "sandbox.command"
      ? [
          {
            key: `c${event.seq}`,
            seq: event.seq,
            stepId: event.stepId,
            purpose: event.payload.purpose,
            command: event.payload.command,
            exitCode: event.payload.exitCode,
            durationMs: event.payload.durationMs,
            timedOut: event.payload.timedOut,
            output: event.payload.output,
            truncated: event.payload.truncated,
            at: event.at,
          },
        ]
      : [],
  );
  const improvement = improvementOf(input);
  return {
    repo: repoName(input.repoUrl),
    title: improvement.title,
    acceptance: improvement.acceptance,
    commands,
    workspace: latest(records, SHIP_WORKSPACE_KIND, ShipWorkspaceSchema),
    baseline: latest(records, SHIP_TEST_REPORT_KIND, ShipTestReportSchema, "baseline"),
    after: latest(records, SHIP_TEST_REPORT_KIND, ShipTestReportSchema, "verify"),
    diff: latest(records, SHIP_DIFF_KIND, ShipDiffSchema),
    approval: state?.ship?.approval ?? null,
    result: latest(records, SHIP_RESULT_KIND, ShipResultSchema),
    pullRequest: state?.ship?.pullRequest ?? null,
  };
}

export type PatchLineKind = "add" | "del" | "ctx" | "meta";

export interface PatchLine {
  kind: PatchLineKind;
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface PatchHunk {
  header: string;
  lines: PatchLine[];
}

export interface PatchFile {
  path: string;
  status: "added" | "deleted" | "modified";
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: PatchHunk[];
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parsePatch(patch: string): PatchFile[] {
  const files: PatchFile[] = [];
  let file: PatchFile | null = null;
  let hunk: PatchHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const path = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)?.[2] ?? line.slice(11);
      file = { path, status: "modified", binary: false, additions: 0, deletions: 0, hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (file === null) continue;
    if (hunk === null) {
      if (line.startsWith("new file mode")) file.status = "added";
      else if (line.startsWith("deleted file mode")) file.status = "deleted";
      else if (line.startsWith("GIT binary patch") || line.startsWith("Binary files"))
        file.binary = true;
    }
    const header = HUNK.exec(line);
    if (header !== null) {
      oldNo = Number(header[1]);
      newNo = Number(header[2]);
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (hunk === null || file.binary) continue;
    if (line.startsWith("+")) {
      hunk.lines.push({ kind: "add", text: line.slice(1), oldNo: null, newNo });
      newNo += 1;
      file.additions += 1;
    } else if (line.startsWith("-")) {
      hunk.lines.push({ kind: "del", text: line.slice(1), oldNo, newNo: null });
      oldNo += 1;
      file.deletions += 1;
    } else if (line.startsWith(" ")) {
      hunk.lines.push({ kind: "ctx", text: line.slice(1), oldNo, newNo });
      oldNo += 1;
      newNo += 1;
    } else if (line.startsWith("\\")) {
      hunk.lines.push({ kind: "meta", text: line, oldNo: null, newNo: null });
    }
  }
  return files;
}

export const COMMAND_PURPOSE_LABELS: Record<SandboxCommandPurpose, string> = {
  setup: "setup",
  clone: "clone",
  install: "install",
  baseline: "baseline",
  engineer: "engineer",
  verify: "verify",
  diff: "diff",
};

export function shipStatusLabel(view: ShipView, running: boolean): string {
  if (view.result?.status === "opened") return "Pull request opened";
  if (view.result?.status === "patch_ready") return "Patch ready";
  if (view.result?.status === "rejected") return "Not shipped";
  if (view.approval?.status === "pending") return "Waiting for your approval";
  if (!running) return "Stopped";
  if (view.after !== null) return "Preparing the review";
  if (view.diff !== null) return "Verifying the change";
  if (view.baseline !== null) return "Engineer at work";
  if (view.workspace !== null) return "Running baseline tests";
  return "Preparing the sandbox";
}
