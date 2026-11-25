import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

export const TAR_LIMITS = {
  maxUncompressedBytes: 256 * 1024 * 1024,
  maxEntries: 50_000,
  chunkBytes: 64 * 1024,
} as const;

const BLOCK = 512;

export type TarEntryType = "file" | "directory" | "symlink" | "hardlink" | "other";

export interface TarEntry {
  path: string;
  type: TarEntryType;
  size: number;
}

export type TarDecision = { keep: true } | { keep: false; reason: string };

export interface TarFile {
  path: string;
  bytes: Uint8Array;
}

export interface TarSkip {
  path: string;
  reason: string;
  size: number;
}

export interface TarReadResult {
  files: TarFile[];
  skipped: TarSkip[];
  entries: number;
  uncompressedBytes: number;
  globalHeaders: Record<string, string>;
  truncated: false | "uncompressed_cap" | "entry_cap";
}

export interface TarReadOptions {
  decide: (entry: TarEntry) => TarDecision;
  maxUncompressedBytes?: number;
  maxEntries?: number;
}

export class TarballError extends Error {
  override readonly name = "TarballError";
  constructor(
    readonly code: "corrupt_gzip" | "corrupt_tar",
    message: string,
  ) {
    super(message);
  }
}

function readString(block: Uint8Array, start: number, length: number): string {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return new TextDecoder("utf-8").decode(end === -1 ? slice : slice.subarray(0, end));
}

function readSize(block: Uint8Array): number {
  const field = block.subarray(124, 136);
  if (((field[0] ?? 0) & 0x80) !== 0) {
    let value = 0;
    for (let index = 1; index < field.length; index += 1) value = value * 256 + (field[index] ?? 0);
    return value;
  }
  const text = readString(block, 124, 12).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new TarballError("corrupt_tar", "Invalid size field");
  return Number.parseInt(text, 8);
}

function checksumMatches(block: Uint8Array): boolean {
  const stored = readString(block, 148, 8).trim();
  if (!/^[0-7]+$/.test(stored)) return false;
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1)
    sum += index >= 148 && index < 156 ? 32 : (block[index] ?? 0);
  return sum === Number.parseInt(stored, 8);
}

function isZeroBlock(block: Uint8Array): boolean {
  return block.every((byte) => byte === 0);
}

function entryType(flag: string): TarEntryType {
  if (flag === "0" || flag === "" || flag === "7") return "file";
  if (flag === "5") return "directory";
  if (flag === "2") return "symlink";
  if (flag === "1") return "hardlink";
  return "other";
}

export function parsePax(bytes: Uint8Array): Record<string, string> {
  const text = new TextDecoder("utf-8").decode(bytes);
  const records: Record<string, string> = {};
  let offset = 0;
  while (offset < text.length) {
    const space = text.indexOf(" ", offset);
    if (space === -1) break;
    const length = Number.parseInt(text.slice(offset, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = text.slice(space + 1, offset + length - 1);
    const equals = record.indexOf("=");
    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return records;
}

export function normaliseEntryPath(raw: string, stripComponents: number): string | null {
  const segments = raw
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
  if (raw.startsWith("/") || segments.some((segment) => segment === "..")) return null;
  const kept = segments.slice(stripComponents);
  return kept.length === 0 ? "" : kept.join("/");
}

type Pending =
  | { kind: "header" }
  | { kind: "body"; entry: TarEntry; remaining: number; padding: number; keep: boolean }
  | { kind: "meta"; flag: string; remaining: number; padding: number };

class TarParser {
  readonly files: TarFile[] = [];
  readonly skipped: TarSkip[] = [];
  readonly globalHeaders: Record<string, string> = {};
  entries = 0;
  done = false;
  entryCapHit = false;
  private buffer: Uint8Array = new Uint8Array(0);
  private pending: Pending = { kind: "header" };
  private chunks: Uint8Array[] = [];
  private paxPath: string | undefined;
  private longName: string | undefined;

  constructor(
    private readonly decide: TarReadOptions["decide"],
    private readonly maxEntries: number,
  ) {}

  push(chunk: Uint8Array): void {
    this.buffer = this.buffer.length === 0 ? chunk : concat(this.buffer, chunk);
    while (!this.done) {
      if (this.pending.kind === "header") {
        if (this.buffer.length < BLOCK) return;
        const block = this.buffer.subarray(0, BLOCK);
        this.buffer = this.buffer.subarray(BLOCK);
        this.header(block);
        continue;
      }
      const pending = this.pending;
      if (pending.remaining > 0) {
        if (this.buffer.length === 0) return;
        const take = Math.min(pending.remaining, this.buffer.length);
        const piece = this.buffer.subarray(0, take);
        this.buffer = this.buffer.subarray(take);
        pending.remaining -= take;
        if (pending.kind === "meta" || pending.keep) this.chunks.push(piece.slice());
        if (pending.remaining > 0) return;
      }
      if (this.buffer.length < pending.padding) {
        pending.padding -= this.buffer.length;
        this.buffer = new Uint8Array(0);
        return;
      }
      this.buffer = this.buffer.subarray(pending.padding);
      this.finish(pending);
    }
  }

  private header(block: Uint8Array): void {
    if (isZeroBlock(block)) {
      this.done = true;
      return;
    }
    if (!checksumMatches(block)) throw new TarballError("corrupt_tar", "Tar header checksum");
    const flag = String.fromCharCode(block[156] ?? 0).replace("\0", "");
    const size = readSize(block);
    const padding = (BLOCK - (size % BLOCK)) % BLOCK;
    if (flag === "x" || flag === "g" || flag === "L") {
      this.chunks = [];
      this.pending = { kind: "meta", flag, remaining: size, padding };
      return;
    }
    const prefix = readString(block, 345, 155);
    const name = readString(block, 0, 100);
    const rawPath = this.paxPath ?? this.longName ?? (prefix === "" ? name : `${prefix}/${name}`);
    this.paxPath = undefined;
    this.longName = undefined;
    const entry: TarEntry = { path: rawPath, type: entryType(flag), size };
    this.entries += 1;
    let keep = false;
    if (this.entries > this.maxEntries) {
      this.entryCapHit = true;
      this.done = true;
      return;
    }
    const decision = this.decide(entry);
    if (decision.keep) keep = true;
    else if (entry.type !== "directory")
      this.skipped.push({ path: entry.path, reason: decision.reason, size });
    this.chunks = [];
    this.pending = { kind: "body", entry, remaining: size, padding, keep };
  }

  private finish(pending: Exclude<Pending, { kind: "header" }>): void {
    const bytes = joinChunks(this.chunks);
    this.chunks = [];
    if (pending.kind === "meta") {
      if (pending.flag === "L") this.longName = readString(bytes, 0, bytes.length);
      else {
        const records = parsePax(bytes);
        if (pending.flag === "g") Object.assign(this.globalHeaders, records);
        else if (records.path !== undefined) this.paxPath = records.path;
      }
    } else if (pending.keep) {
      this.files.push({ path: pending.entry.path, bytes });
    }
    this.pending = { kind: "header" };
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function joinChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function* slices(bytes: Uint8Array, size: number): Generator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += size)
    yield bytes.subarray(offset, offset + size);
}

export async function readTarGz(
  compressed: Uint8Array,
  options: TarReadOptions,
): Promise<TarReadResult> {
  const maxBytes = options.maxUncompressedBytes ?? TAR_LIMITS.maxUncompressedBytes;
  const parser = new TarParser(options.decide, options.maxEntries ?? TAR_LIMITS.maxEntries);
  const gunzip = createGunzip();
  const stream = Readable.from(slices(compressed, TAR_LIMITS.chunkBytes)).pipe(gunzip);
  let total = 0;
  let truncated: TarReadResult["truncated"] = false;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      total += chunk.length;
      if (total > maxBytes) {
        truncated = "uncompressed_cap";
        break;
      }
      parser.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      if (parser.done) break;
    }
  } catch (error) {
    if (error instanceof TarballError) throw error;
    throw new TarballError(
      "corrupt_gzip",
      error instanceof Error ? `Not a valid gzip stream: ${error.message}` : "Not a valid gzip",
    );
  } finally {
    stream.destroy();
  }
  if (parser.entryCapHit) truncated = "entry_cap";
  return {
    files: parser.files,
    skipped: parser.skipped,
    entries: parser.entries,
    uncompressedBytes: Math.min(total, maxBytes),
    globalHeaders: parser.globalHeaders,
    truncated,
  };
}
