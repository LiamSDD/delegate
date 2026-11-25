import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { posix } from "node:path";

import {
  EXEC_OUTPUT_MAX_BYTES,
  SandboxUnavailableError,
  keepTail,
  type ExecRequest,
  type ExecResult,
  type Sandbox,
  type SandboxProvider,
} from "./types";

const ID_PREFIX = "delegate-sandbox-";
const ID_PATTERN = /^delegate-sandbox-[A-Za-z0-9_-]{4,64}$/;
const MAX_SYMLINK_HOPS = 40;

export interface LocalSandboxOptions {
  root?: string;
  path?: string;
  production?: boolean;
}

export function scrubbedEnv(workdir: string, path: string): Record<string, string> {
  return {
    PATH: path,
    HOME: posix.join(workdir, "home"),
    TMPDIR: posix.join(workdir, "tmp"),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    CI: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: posix.join(workdir, "home", ".gitconfig"),
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function canonical(path: string, hops = 0): Promise<string> {
  if (hops > MAX_SYMLINK_HOPS) throw new Error("Too many symbolic links");
  const rest: string[] = [];
  let current = posix.normalize(path);
  for (;;) {
    try {
      const real = await realpath(current);
      return rest.length === 0 ? real : posix.join(real, ...rest.reverse());
    } catch {
      const dangling = await lstat(current).then(
        (info) => info.isSymbolicLink(),
        () => false,
      );
      if (dangling) {
        const target = posix.resolve(posix.dirname(current), await readlink(current));
        return canonical(posix.join(target, ...[...rest].reverse()), hops + 1);
      }
      const parent = posix.dirname(current);
      if (parent === current) return posix.join(current, ...rest.reverse());
      rest.push(posix.basename(current));
      current = parent;
    }
  }
}

function collector(limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  let dropped = false;
  return {
    push(chunk: Buffer) {
      chunks.push(chunk);
      size += chunk.length;
      while (size > limit && chunks.length > 1) {
        const first = chunks.shift();
        size -= first?.length ?? 0;
        dropped = true;
      }
    },
    text() {
      const joined = Buffer.concat(chunks).toString("utf8");
      const tail = keepTail(joined, limit);
      return { text: tail.text, truncated: dropped || tail.truncated };
    },
  };
}

class LocalProcessSandbox implements Sandbox {
  readonly kind = "local" as const;
  readonly repoDir: string;

  constructor(
    readonly id: string,
    readonly workdir: string,
    private readonly path: string,
  ) {
    this.repoDir = posix.join(workdir, "repo");
  }

  exec(request: ExecRequest): Promise<ExecResult> {
    const cwd = request.in === "workdir" ? this.workdir : this.repoDir;
    const started = Date.now();
    return new Promise((resolve) => {
      const stdout = collector(EXEC_OUTPUT_MAX_BYTES);
      const stderr = collector(EXEC_OUTPUT_MAX_BYTES);
      let timedOut = false;
      let settled = false;
      const child = spawn(request.cmd, [...request.args], {
        cwd,
        env: scrubbedEnv(this.workdir, this.path),
        detached: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const kill = () => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, request.timeoutMs);
      const onAbort = () => {
        kill();
      };
      request.signal?.addEventListener("abort", onAbort, { once: true });
      const finish = (exitCode: number | null, extra = "") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
        const out = stdout.text();
        const err = stderr.text();
        resolve({
          exitCode: timedOut ? null : exitCode,
          stdout: out.text,
          stderr: `${err.text}${extra}`,
          durationMs: Date.now() - started,
          timedOut,
          truncated: out.truncated || err.truncated,
        });
      };
      child.stdout.on("data", (chunk: Buffer) => {
        stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr.push(chunk);
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        finish(error.code === "ENOENT" ? 127 : 126, `${request.cmd}: ${error.code ?? "failed"}`);
      });
      child.on("close", (code) => {
        finish(code);
      });
    });
  }

  resolve(absolutePath: string): Promise<string> {
    return canonical(absolutePath);
  }

  async readFile(absolutePath: string, maxBytes: number): Promise<Uint8Array | null> {
    try {
      const info = await stat(absolutePath);
      if (!info.isFile()) return null;
      if (info.size > maxBytes) return (await readFile(absolutePath)).subarray(0, maxBytes);
      return await readFile(absolutePath);
    } catch {
      return null;
    }
  }

  async writeFile(absolutePath: string, content: Uint8Array): Promise<void> {
    await mkdir(posix.dirname(absolutePath), { recursive: true });
    const handle = await open(
      absolutePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o644,
    );
    try {
      await handle.writeFile(content);
    } finally {
      await handle.close();
    }
  }

  setNetwork(): Promise<void> {
    return Promise.resolve();
  }

  extend(): Promise<void> {
    return Promise.resolve();
  }

  async close(): Promise<void> {
    await rm(this.workdir, { recursive: true, force: true });
  }
}

export function createLocalSandboxProvider(options: LocalSandboxOptions = {}): SandboxProvider {
  const hostPath = options.path ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  const rootDir = async () => realpath(options.root ?? tmpdir());
  const refuseInProduction = () => {
    if (options.production === true)
      throw new SandboxUnavailableError(
        "The local process sandbox is for development only and cannot run untrusted code in production; set DELEGATE_SANDBOX=vercel.",
      );
  };
  return {
    kind: "local",
    async create() {
      refuseInProduction();
      const workdir = await realpath(await mkdtemp(posix.join(await rootDir(), ID_PREFIX)));
      await mkdir(posix.join(workdir, "home"), { recursive: true });
      await mkdir(posix.join(workdir, "tmp"), { recursive: true });
      return new LocalProcessSandbox(posix.basename(workdir), workdir, hostPath);
    },
    async attach(id) {
      refuseInProduction();
      if (!ID_PATTERN.test(id)) return null;
      const workdir = posix.join(await rootDir(), id);
      if (!(await exists(posix.join(workdir, "home")))) return null;
      return new LocalProcessSandbox(id, workdir, hostPath);
    },
  };
}
