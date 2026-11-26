export interface CliFiles {
  read(path: string): Promise<string | null>;
  mode(path: string): Promise<number | null>;
  writePrivate(path: string, content: string): Promise<void>;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<boolean>;
}

export interface CliIo {
  env: Record<string, string | undefined>;
  homeDir: string;
  platform: string;
  stdout(text: string): void;
  stderr(text: string): void;
  stdinIsTty: boolean;
  stdoutIsTty: boolean;
  readSecret(prompt: string): Promise<string>;
  readStdin(): Promise<string>;
  fetch: typeof fetch;
  files: CliFiles;
  signal: AbortSignal;
  now(): number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIR_MODE = 0o700;
