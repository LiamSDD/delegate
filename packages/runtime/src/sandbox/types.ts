export const SANDBOX_KINDS = ["local", "vercel"] as const;
export type SandboxKind = (typeof SANDBOX_KINDS)[number];

export type NetworkPhase = "setup" | "work";

export interface ExecRequest {
  cmd: string;
  args: readonly string[];
  in?: "repo" | "workdir";
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

export interface Sandbox {
  readonly id: string;
  readonly kind: SandboxKind;
  readonly workdir: string;
  readonly repoDir: string;
  exec(request: ExecRequest): Promise<ExecResult>;
  resolve(absolutePath: string): Promise<string>;
  readFile(absolutePath: string, maxBytes: number): Promise<Uint8Array | null>;
  writeFile(absolutePath: string, content: Uint8Array): Promise<void>;
  setNetwork(phase: NetworkPhase): Promise<void>;
  extend(ms: number): Promise<void>;
  close(): Promise<void>;
}

export interface SandboxProvider {
  readonly kind: SandboxKind;
  create(options?: { signal?: AbortSignal }): Promise<Sandbox>;
  attach(id: string): Promise<Sandbox | null>;
}

export class SandboxUnavailableError extends Error {
  override readonly name = "SandboxUnavailableError";
  readonly code = "sandbox_unavailable";
}

export const EXEC_OUTPUT_MAX_BYTES = 256 * 1024;

export function keepTail(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(text.length - maxChars), truncated: true };
}
