import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { type CliFiles, type CliIo, PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from "./io";

const CTRL_C = "\u0003";
const CTRL_D = "\u0004";
const BACKSPACE = new Set(["\u007f", "\b"]);
const SECRET_MAX_CHARS = 4_096;

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export const nodeFiles: CliFiles = {
  async read(file) {
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  },
  async mode(file) {
    try {
      return (await stat(file)).mode & 0o777;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  },
  async writePrivate(file, content) {
    await mkdir(path.dirname(file), { recursive: true, mode: PRIVATE_DIR_MODE });
    const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    const handle = await open(temporary, "wx", PRIVATE_FILE_MODE);
    try {
      await handle.writeFile(content, "utf8");
      await handle.chmod(PRIVATE_FILE_MODE);
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    await chmod(file, PRIVATE_FILE_MODE);
  },
  async write(file, content) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
  },
  async remove(file) {
    try {
      await rm(file);
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  },
};

function readSecret(prompt: string): Promise<string> {
  const input = process.stdin;
  return new Promise((resolve, reject) => {
    let secret = "";
    process.stderr.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    const finish = (error: Error | null) => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      process.stderr.write("\n");
      if (error === null) resolve(secret);
      else reject(error);
    };
    function onData(chunk: string) {
      for (const char of chunk) {
        if (char === CTRL_C) {
          finish(new DOMException("Interrupted", "AbortError"));
          return;
        }
        if (char === "\r" || char === "\n" || char === CTRL_D) {
          finish(null);
          return;
        }
        if (BACKSPACE.has(char)) secret = secret.slice(0, -1);
        else if (char >= " " && secret.length < SECRET_MAX_CHARS) secret += char;
      }
    }
    input.on("data", onData);
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += bytes.byteLength;
    if (size > SECRET_MAX_CHARS * 4) break;
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function nodeIo(): CliIo {
  const interrupt = new AbortController();
  process.once("SIGINT", () => {
    interrupt.abort(new DOMException("Interrupted", "AbortError"));
  });
  return {
    env: process.env,
    homeDir: homedir(),
    platform: process.platform,
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    stdinIsTty: process.stdin.isTTY,
    stdoutIsTty: process.stdout.isTTY,
    readSecret,
    readStdin,
    fetch: (input, init) => fetch(input, init),
    files: nodeFiles,
    signal: interrupt.signal,
    now: () => Date.now(),
  };
}
