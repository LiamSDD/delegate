import { posix } from "node:path";

import type * as VercelSdk from "@vercel/sandbox";
import type { NetworkPolicy, Sandbox as VercelHandle } from "@vercel/sandbox";

import {
  EXEC_OUTPUT_MAX_BYTES,
  SandboxUnavailableError,
  keepTail,
  type ExecRequest,
  type ExecResult,
  type NetworkPhase,
  type Sandbox,
  type SandboxProvider,
} from "./types";

export const VERCEL_SANDBOX_LIMITS = {
  sessionMs: 30 * 60_000,
  vcpus: 2,
  workdir: "/vercel/sandbox",
} as const;

const PRIVATE_SUBNETS = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
  "127.0.0.0/8",
  "100.64.0.0/10",
];

const REGISTRY_HOSTS = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
];

const SOURCE_HOSTS = ["github.com", "codeload.github.com"];

export const NETWORK_POLICIES: Record<NetworkPhase, NetworkPolicy> = {
  setup: { allow: [...SOURCE_HOSTS, ...REGISTRY_HOSTS], subnets: { deny: PRIVATE_SUBNETS } },
  work: { allow: [...REGISTRY_HOSTS], subnets: { deny: PRIVATE_SUBNETS } },
};

const COMMAND_ENV = {
  CI: "1",
  NO_COLOR: "1",
  GIT_TERMINAL_PROMPT: "0",
  npm_config_update_notifier: "false",
  npm_config_fund: "false",
  npm_config_audit: "false",
};

const TOKEN_PATTERN = /(eyJ[\w-]+\.[\w-]+\.[\w-]+|[A-Za-z0-9_-]{32,})/g;

export function sanitiseProviderError(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown error";
  return message.replace(TOKEN_PATTERN, "[redacted]").slice(0, 240);
}

async function loadSdk(): Promise<typeof VercelSdk> {
  try {
    return await import("@vercel/sandbox");
  } catch (error) {
    throw new SandboxUnavailableError(
      `Vercel Sandbox SDK could not be loaded: ${sanitiseProviderError(error)}`,
    );
  }
}

class VercelSandbox implements Sandbox {
  readonly kind = "vercel" as const;
  readonly workdir = VERCEL_SANDBOX_LIMITS.workdir;
  readonly repoDir = posix.join(VERCEL_SANDBOX_LIMITS.workdir, "repo");

  constructor(private readonly handle: VercelHandle) {}

  get id(): string {
    return this.handle.name;
  }

  async exec(request: ExecRequest): Promise<ExecResult> {
    const started = Date.now();
    try {
      const finished = await this.handle.runCommand({
        cmd: request.cmd,
        args: [...request.args],
        cwd: request.in === "workdir" ? this.workdir : this.repoDir,
        env: COMMAND_ENV,
        timeoutMs: request.timeoutMs,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      const [stdout, stderr] = await Promise.all([finished.stdout(), finished.stderr()]);
      const out = keepTail(stdout, EXEC_OUTPUT_MAX_BYTES);
      const err = keepTail(stderr, EXEC_OUTPUT_MAX_BYTES);
      const durationMs = finished.durationMs ?? Date.now() - started;
      const timedOut = durationMs >= request.timeoutMs;
      return {
        exitCode: timedOut ? null : finished.exitCode,
        stdout: out.text,
        stderr: err.text,
        durationMs,
        timedOut,
        truncated: out.truncated || err.truncated,
      };
    } catch (error) {
      if (request.signal?.aborted === true) throw error;
      throw new SandboxUnavailableError(
        `Vercel Sandbox command failed: ${sanitiseProviderError(error)}`,
      );
    }
  }

  async resolve(absolutePath: string): Promise<string> {
    const result = await this.exec({
      cmd: "realpath",
      args: ["-m", "--", absolutePath],
      in: "workdir",
      timeoutMs: 15_000,
    });
    const resolved = result.stdout.trim();
    if (result.exitCode !== 0 || !resolved.startsWith("/"))
      throw new Error(`Could not resolve ${posix.basename(absolutePath)}`);
    return resolved;
  }

  async readFile(absolutePath: string, maxBytes: number): Promise<Uint8Array | null> {
    const buffer = await this.handle.readFileToBuffer({ path: absolutePath });
    if (buffer === null) return null;
    return buffer.length > maxBytes ? buffer.subarray(0, maxBytes) : buffer;
  }

  async writeFile(absolutePath: string, content: Uint8Array): Promise<void> {
    await this.handle.mkDir(posix.dirname(absolutePath)).catch(() => undefined);
    await this.handle.writeFiles([{ path: absolutePath, content }]);
  }

  async setNetwork(phase: NetworkPhase): Promise<void> {
    await this.handle.update({ networkPolicy: NETWORK_POLICIES[phase] });
  }

  async extend(ms: number): Promise<void> {
    await this.handle.extendTimeout(ms).catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.handle.stop().catch(() => undefined);
  }
}

export function createVercelSandboxProvider(): SandboxProvider {
  return {
    kind: "vercel",
    async create(options) {
      const sdk = await loadSdk();
      try {
        const handle = await sdk.Sandbox.create({
          timeout: VERCEL_SANDBOX_LIMITS.sessionMs,
          resources: { vcpus: VERCEL_SANDBOX_LIMITS.vcpus },
          networkPolicy: NETWORK_POLICIES.setup,
          persistent: false,
          tags: { app: "delegate", mission: "ship-a-pr" },
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
        });
        return new VercelSandbox(handle);
      } catch (error) {
        throw new SandboxUnavailableError(
          `Vercel Sandbox is unavailable: ${sanitiseProviderError(error)}`,
        );
      }
    },
    async attach(id) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
      const sdk = await loadSdk();
      try {
        return new VercelSandbox(await sdk.Sandbox.get({ name: id }));
      } catch {
        return null;
      }
    },
  };
}
