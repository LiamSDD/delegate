import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { posix } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  NETWORK_POLICIES,
  SandboxPathError,
  SandboxUnavailableError,
  confinePath,
  createLocalSandboxProvider,
  createSandboxProvider,
  isProtectedPath,
  normaliseRepoPath,
  sandboxKindFor,
  sanitiseProviderError,
  type Sandbox,
} from "./index";

let root: string;
const opened: Sandbox[] = [];

beforeAll(async () => {
  root = await realpath(await mkdtemp(posix.join(tmpdir(), "delegate-sandbox-test-")));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

afterEach(async () => {
  await Promise.all(opened.splice(0).map((sandbox) => sandbox.close()));
});

async function sandboxWithRepo(): Promise<Sandbox> {
  const sandbox = await createLocalSandboxProvider({ root }).create();
  opened.push(sandbox);
  await mkdir(sandbox.repoDir, { recursive: true });
  return sandbox;
}

function code(error: unknown): string | undefined {
  return error instanceof SandboxPathError ? error.code : undefined;
}

async function confineCode(
  sandbox: Sandbox,
  path: string,
  mode: "read" | "write",
): Promise<string> {
  try {
    await confinePath(sandbox, path, mode);
    return "ok";
  } catch (error) {
    return code(error) ?? "error";
  }
}

describe("normaliseRepoPath", () => {
  it("normalises relative paths", () => {
    expect(normaliseRepoPath("./src//index.ts")).toBe("src/index.ts");
    expect(normaliseRepoPath(".")).toBe("");
  });

  it.each([
    ["../outside", "path_escape"],
    ["src/../../outside", "path_escape"],
    ["/etc/passwd", "path_escape"],
    ["~/.ssh/id_rsa", "path_escape"],
    ["C:/Windows", "path_escape"],
    [".git/config", "path_protected"],
    ["src/.GIT/hooks/pre-commit", "path_protected"],
    ["src\\index.ts", "path_invalid"],
    ["src/\0index.ts", "path_invalid"],
  ])("rejects %s", (path, expected) => {
    let caught: unknown;
    try {
      normaliseRepoPath(path);
    } catch (error) {
      caught = error;
    }
    expect(code(caught)).toBe(expected);
  });

  it("marks CI configuration as protected", () => {
    expect(isProtectedPath(".github/workflows/ci.yml")).toBe(true);
    expect(isProtectedPath(".GitHub/Workflows/release.yml")).toBe(true);
    expect(isProtectedPath(".gitlab-ci.yml")).toBe(true);
    expect(isProtectedPath(".github/ISSUE_TEMPLATE.md")).toBe(false);
    expect(isProtectedPath("src/workflows/run.ts")).toBe(false);
  });
});

describe("confinePath with a local sandbox", () => {
  it("allows files inside the repository, existing or new", async () => {
    const sandbox = await sandboxWithRepo();
    await writeFile(posix.join(sandbox.repoDir, "a.txt"), "a");
    expect(await confineCode(sandbox, "a.txt", "read")).toBe("ok");
    expect(await confineCode(sandbox, "src/new/file.ts", "write")).toBe("ok");
  });

  it("refuses a symlinked directory that points outside the repository", async () => {
    const sandbox = await sandboxWithRepo();
    const outside = posix.join(root, "outside-dir");
    await mkdir(outside, { recursive: true });
    await symlink(outside, posix.join(sandbox.repoDir, "linked"));
    expect(await confineCode(sandbox, "linked/payload.sh", "write")).toBe("path_escape");
    expect(await confineCode(sandbox, "linked", "read")).toBe("path_escape");
  });

  it("refuses a dangling symlink whose target is outside the repository", async () => {
    const sandbox = await sandboxWithRepo();
    await symlink(posix.join(root, "not-yet-there.txt"), posix.join(sandbox.repoDir, "trap.txt"));
    expect(await confineCode(sandbox, "trap.txt", "write")).toBe("path_escape");
  });

  it("refuses a symlink into .git and protected CI paths", async () => {
    const sandbox = await sandboxWithRepo();
    await mkdir(posix.join(sandbox.repoDir, ".git", "hooks"), { recursive: true });
    await symlink(
      posix.join(sandbox.repoDir, ".git", "hooks"),
      posix.join(sandbox.repoDir, "hooks"),
    );
    expect(await confineCode(sandbox, "hooks/pre-commit", "write")).toBe("path_protected");
    expect(await confineCode(sandbox, ".github/workflows/ci.yml", "write")).toBe("path_protected");
    expect(await confineCode(sandbox, ".github/workflows/ci.yml", "read")).toBe("ok");
  });

  it("writes through the resolved path without following a final symlink", async () => {
    const sandbox = await sandboxWithRepo();
    const target = await confinePath(sandbox, "src/out.txt", "write");
    await sandbox.writeFile(target.absolute, new TextEncoder().encode("hello"));
    expect(await readFile(posix.join(sandbox.repoDir, "src", "out.txt"), "utf8")).toBe("hello");
    await symlink(
      posix.join(sandbox.repoDir, "src", "out.txt"),
      posix.join(sandbox.repoDir, "alias"),
    );
    await expect(
      sandbox.writeFile(posix.join(sandbox.repoDir, "alias"), new Uint8Array([1])),
    ).rejects.toThrow();
  });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("LocalProcessSandbox exec", () => {
  it("runs argv without a shell and reports the exit code", async () => {
    const sandbox = await sandboxWithRepo();
    const result = await sandbox.exec({
      cmd: "node",
      args: ["-e", "process.exit(3)"],
      timeoutMs: 10_000,
    });
    expect(result).toMatchObject({ exitCode: 3, timedOut: false });
    const injected = await sandbox.exec({
      cmd: "echo",
      args: ["$(whoami); rm -rf /"],
      timeoutMs: 5_000,
    });
    expect(injected.stdout.trim()).toBe("$(whoami); rm -rf /");
  });

  it("passes a scrubbed environment with no inherited secrets", async () => {
    process.env.DELEGATE_TEST_CANARY = "canary-value-7f3a";
    process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN canary";
    try {
      const sandbox = await sandboxWithRepo();
      const result = await sandbox.exec({
        cmd: "node",
        args: ["-e", "console.log(JSON.stringify(process.env))"],
        timeoutMs: 10_000,
      });
      const env = JSON.parse(result.stdout) as Record<string, string>;
      expect(result.stdout).not.toContain("canary");
      expect(Object.keys(env)).not.toContain("GITHUB_APP_PRIVATE_KEY");
      expect(env.HOME?.startsWith(sandbox.workdir)).toBe(true);
      expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    } finally {
      delete process.env.DELEGATE_TEST_CANARY;
      delete process.env.GITHUB_APP_PRIVATE_KEY;
    }
  });

  it("kills a command and its children at the timeout", async () => {
    const sandbox = await sandboxWithRepo();
    const marker = posix.join(sandbox.workdir, "child-survived");
    const started = Date.now();
    const result = await sandbox.exec({
      cmd: "node",
      args: [
        "-e",
        `require("child_process").spawn("sh", ["-c", "sleep 1; touch ${marker}"], { stdio: "ignore" }); setInterval(() => {}, 1000);`,
      ],
      timeoutMs: 300,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(3_000);
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    expect(await readdir(sandbox.workdir)).not.toContain("child-survived");
  });

  it("kills background processes left behind when a command exits", async () => {
    const sandbox = await sandboxWithRepo();
    const marker = posix.join(sandbox.workdir, "background-survived");
    const pidFile = posix.join(sandbox.workdir, "background.pid");
    const started = Date.now();
    const result = await sandbox.exec({
      cmd: "sh",
      args: ["-c", `(sleep 30; touch ${marker}) & echo $! > ${pidFile}; echo started`],
      timeoutMs: 20_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(Date.now() - started).toBeLessThan(15_000);
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    await expect.poll(() => isAlive(pid), { timeout: 5_000, interval: 50 }).toBe(false);
    expect(await readdir(sandbox.workdir)).not.toContain("background-survived");
  });

  it("reports a missing binary as exit 127 instead of throwing", async () => {
    const sandbox = await sandboxWithRepo();
    const result = await sandbox.exec({
      cmd: "definitely-not-a-binary",
      args: [],
      timeoutMs: 5_000,
    });
    expect(result.exitCode).toBe(127);
  });

  it("keeps only the tail of very large output", async () => {
    const sandbox = await sandboxWithRepo();
    const result = await sandbox.exec({
      cmd: "node",
      args: ["-e", "process.stdout.write('x'.repeat(600000) + 'END')"],
      timeoutMs: 10_000,
    });
    expect(result.truncated).toBe(true);
    expect(result.stdout.endsWith("END")).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(256 * 1024);
  });

  it("re-attaches by id and closes by deleting the workdir", async () => {
    const provider = createLocalSandboxProvider({ root });
    const sandbox = await provider.create();
    const again = await provider.attach(sandbox.id);
    expect(again?.workdir).toBe(sandbox.workdir);
    expect(await provider.attach("../../etc")).toBeNull();
    await sandbox.close();
    expect(await provider.attach(sandbox.id)).toBeNull();
  });
});

describe("sandbox selection", () => {
  it("defaults to local in development and Vercel in production", () => {
    expect(sandboxKindFor({ NODE_ENV: "development" })).toBe("local");
    expect(sandboxKindFor({ NODE_ENV: "production" })).toBe("vercel");
    expect(sandboxKindFor({ NODE_ENV: "development", DELEGATE_SANDBOX: "vercel" })).toBe("vercel");
    expect(() => sandboxKindFor({ DELEGATE_SANDBOX: "docker" })).toThrow(SandboxUnavailableError);
  });

  it("refuses to run the local sandbox in production", async () => {
    const provider = createSandboxProvider({ NODE_ENV: "production", DELEGATE_SANDBOX: "local" });
    await expect(provider.create()).rejects.toBeInstanceOf(SandboxUnavailableError);
  });

  it("restricts Vercel Sandbox egress after setup to package registries", () => {
    const work = NETWORK_POLICIES.work;
    expect(typeof work === "object" && Array.isArray(work.allow) ? work.allow : []).not.toContain(
      "github.com",
    );
    expect(JSON.stringify(work)).toContain("169.254.0.0/16");
  });

  it("strips tokens from provider error messages", () => {
    const message = sanitiseProviderError(
      new Error(
        "auth failed for eyJhbGciOi.eyJzdWIiOiJ4In0.c2lnbmF0dXJl and abcdefghijklmnopqrstuvwxyz0123456789",
      ),
    );
    expect(message).not.toContain("eyJ");
    expect(message).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
  });
});
