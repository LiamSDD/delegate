import { gzipSync } from "node:zlib";

export interface TarFixtureEntry {
  path: string;
  content?: string | Uint8Array;
  type?: "file" | "directory" | "symlink" | "pax-global" | "pax-path" | "gnu-longname";
  linkTarget?: string;
}

const BLOCK = 512;
const encoder = new TextEncoder();

function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

function writeString(block: Uint8Array, text: string, offset: number, length: number): void {
  const bytes = encoder.encode(text);
  block.set(bytes.subarray(0, length), offset);
}

function header(path: string, size: number, flag: string, linkTarget = ""): Uint8Array {
  const block = new Uint8Array(BLOCK);
  writeString(block, path.slice(0, 100), 0, 100);
  writeString(block, octal(0o644, 8), 100, 8);
  writeString(block, octal(0, 8), 108, 8);
  writeString(block, octal(0, 8), 116, 8);
  writeString(block, octal(size, 12), 124, 12);
  writeString(block, octal(0, 12), 136, 12);
  writeString(block, "        ", 148, 8);
  writeString(block, flag, 156, 1);
  writeString(block, linkTarget, 157, 100);
  writeString(block, "ustar\0", 257, 6);
  writeString(block, "00", 263, 2);
  let sum = 0;
  for (const byte of block) sum += byte;
  writeString(block, `${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return block;
}

function padded(bytes: Uint8Array): Uint8Array {
  const size = Math.ceil(bytes.length / BLOCK) * BLOCK;
  const out = new Uint8Array(size);
  out.set(bytes);
  return out;
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = body.length + 1;
  while (`${length}${body}`.length !== length) length = `${length}${body}`.length;
  return `${length}${body}`;
}

export function tarEntries(entries: readonly TarFixtureEntry[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    const type = entry.type ?? "file";
    if (type === "pax-global" || type === "pax-path") {
      const body = encoder.encode(
        type === "pax-global" ? paxRecord("comment", entry.path) : paxRecord("path", entry.path),
      );
      blocks.push(
        header("pax_header", body.length, type === "pax-global" ? "g" : "x"),
        padded(body),
      );
      if (type === "pax-path") {
        const content =
          typeof entry.content === "string"
            ? encoder.encode(entry.content)
            : (entry.content ?? new Uint8Array());
        blocks.push(header("placeholder", content.length, "0"), padded(content));
      }
      continue;
    }
    if (type === "gnu-longname") {
      const name = encoder.encode(`${entry.path}\0`);
      blocks.push(header("././@LongLink", name.length, "L"), padded(name));
      const content =
        typeof entry.content === "string"
          ? encoder.encode(entry.content)
          : (entry.content ?? new Uint8Array());
      blocks.push(header("truncated-name", content.length, "0"), padded(content));
      continue;
    }
    if (type === "directory") {
      blocks.push(header(entry.path, 0, "5"));
      continue;
    }
    if (type === "symlink") {
      blocks.push(header(entry.path, 0, "2", entry.linkTarget ?? ""));
      continue;
    }
    const content =
      typeof entry.content === "string"
        ? encoder.encode(entry.content)
        : (entry.content ?? new Uint8Array());
    blocks.push(header(entry.path, content.length, "0"), padded(content));
  }
  blocks.push(new Uint8Array(BLOCK * 2));
  const total = blocks.reduce((sum, block) => sum + block.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.length;
  }
  return out;
}

export function repoTarGz(
  root: string,
  files: Record<string, string | Uint8Array>,
  commit?: string,
): Uint8Array {
  const entries: TarFixtureEntry[] = [
    ...(commit === undefined ? [] : [{ path: commit, type: "pax-global" as const }]),
    { path: `${root}/`, type: "directory" },
    ...Object.entries(files).map(([path, content]) => ({ path: `${root}/${path}`, content })),
  ];
  return new Uint8Array(gzipSync(tarEntries(entries)));
}
