import { normaliseEntryPath, readTarGz, type TarDecision, type TarEntry } from "./tarball";
import { assessSecret, redactSecrets, type SecretAssessment, type SecretKind } from "./secrets";

export const SNAPSHOT_LIMITS = {
  maxCompressedBytes: 25 * 1024 * 1024,
  maxFileBytes: 256 * 1024,
  maxKeptBytes: 24 * 1024 * 1024,
  maxKeptFiles: 6_000,
  sniffBytes: 8_000,
} as const;

export const SKIP_REASONS = [
  "vendored",
  "build_output",
  "lockfile",
  "binary",
  "generated",
  "too_large",
  "not_regular_file",
  "unsafe_path",
  "snapshot_cap",
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

const VENDORED_SEGMENTS = new Set([
  "node_modules",
  "vendor",
  "vendors",
  "third_party",
  "third-party",
  "bower_components",
  ".git",
  ".hg",
  ".svn",
  ".venv",
  "venv",
  "site-packages",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".tox",
  ".yarn",
  ".pnpm-store",
  "Pods",
  ".gradle",
  ".idea",
]);
const BUILD_SEGMENTS = new Set([
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  "_build",
]);
export const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "pdm.lock",
  "Cargo.lock",
  "go.sum",
  "composer.lock",
  "Gemfile.lock",
  "mix.lock",
  "packages.lock.json",
]);
const BINARY_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "icns",
  "tif",
  "tiff",
  "psd",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "zip",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "7z",
  "rar",
  "tar",
  "jar",
  "war",
  "class",
  "pyc",
  "pyo",
  "so",
  "dylib",
  "dll",
  "exe",
  "bin",
  "o",
  "a",
  "wasm",
  "pdf",
  "mp3",
  "mp4",
  "mov",
  "avi",
  "webm",
  "wav",
  "ogg",
  "flac",
  "sqlite",
  "db",
  "parquet",
  "pkl",
  "npy",
  "onnx",
  "pt",
]);
const GENERATED_SUFFIXES = [".min.js", ".min.css", ".map", ".bundle.js", ".pb.go", "_pb2.py"];

export interface RepoFile {
  path: string;
  text: string;
  bytes: number;
  lineCount: number;
}

export interface SkippedFile {
  path: string;
  reason: SkipReason;
  bytes: number;
}

export type SecretFinding = {
  kind: SecretKind;
  path: string;
  line: number;
} & SecretAssessment;

export interface RepoCoordinates {
  owner: string;
  repo: string;
  ref: string;
}

export interface RepoSnapshot extends RepoCoordinates {
  commit: string | null;
  files: ReadonlyMap<string, RepoFile>;
  skipped: readonly SkippedFile[];
  secrets: readonly SecretFinding[];
  lockfiles: readonly string[];
  entries: number;
  compressedBytes: number;
  uncompressedBytes: number;
  truncated: false | "uncompressed_cap" | "entry_cap";
}

export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function skipReasonFor(path: string, size: number): SkipReason | null {
  const segments = path.split("/");
  const directories = segments.slice(0, -1);
  if (directories.some((segment) => VENDORED_SEGMENTS.has(segment))) return "vendored";
  if (directories.some((segment) => BUILD_SEGMENTS.has(segment))) return "build_output";
  const base = segments.at(-1) ?? "";
  if (LOCKFILES.has(base)) return "lockfile";
  if (BINARY_EXTENSIONS.has(extensionOf(base))) return "binary";
  if (GENERATED_SUFFIXES.some((suffix) => base.endsWith(suffix))) return "generated";
  if (size > SNAPSHOT_LIMITS.maxFileBytes) return "too_large";
  return null;
}

const fatalDecoder = new TextDecoder("utf-8", { fatal: true });

export function decodeText(bytes: Uint8Array): string | null {
  const head = bytes.subarray(0, SNAPSHOT_LIMITS.sniffBytes);
  if (head.includes(0)) return null;
  try {
    return fatalDecoder.decode(bytes).replace(/^\uFEFF/u, "");
  } catch {
    return null;
  }
}

function countLines(text: string): number {
  if (text === "") return 0;
  let lines = 1;
  for (let index = 0; index < text.length; index += 1)
    if (text.charCodeAt(index) === 10) lines += 1;
  return text.endsWith("\n") ? lines - 1 : lines;
}

export function fileLines(file: RepoFile): string[] {
  const lines = file.text.split("\n").map((line) => line.replace(/\r$/, ""));
  return lines.length > file.lineCount ? lines.slice(0, file.lineCount) : lines;
}

export async function snapshotFromTarball(
  compressed: Uint8Array,
  coordinates: RepoCoordinates,
): Promise<RepoSnapshot> {
  const skipped: SkippedFile[] = [];
  const lockfiles: string[] = [];
  const stripped = (raw: string) => normaliseEntryPath(raw, 1);
  let keptBytes = 0;
  let keptFiles = 0;
  const decide = (entry: TarEntry): TarDecision => {
    if (entry.type === "directory") return { keep: false, reason: "directory" };
    const path = stripped(entry.path);
    if (path === null) return { keep: false, reason: "unsafe_path" };
    if (path === "") return { keep: false, reason: "not_regular_file" };
    if (entry.type !== "file") return { keep: false, reason: "not_regular_file" };
    const reason = skipReasonFor(path, entry.size);
    if (reason === "lockfile") lockfiles.push(path);
    if (reason !== null) return { keep: false, reason };
    if (
      keptBytes + entry.size > SNAPSHOT_LIMITS.maxKeptBytes ||
      keptFiles >= SNAPSHOT_LIMITS.maxKeptFiles
    )
      return { keep: false, reason: "snapshot_cap" };
    keptBytes += entry.size;
    keptFiles += 1;
    return { keep: true };
  };
  const result = await readTarGz(compressed, { decide });
  for (const skip of result.skipped) {
    const path = stripped(skip.path);
    skipped.push({
      path: path === null || path === "" ? skip.path.slice(0, 300) : path,
      reason: (SKIP_REASONS as readonly string[]).includes(skip.reason)
        ? (skip.reason as SkipReason)
        : "not_regular_file",
      bytes: skip.size,
    });
  }
  const files = new Map<string, RepoFile>();
  const secrets: SecretFinding[] = [];
  for (const file of result.files) {
    const path = stripped(file.path);
    if (path === null || path === "") continue;
    const text = decodeText(file.bytes);
    if (text === null) {
      skipped.push({ path, reason: "binary", bytes: file.bytes.length });
      continue;
    }
    const redacted = redactSecrets(text);
    for (const hit of redacted.hits)
      secrets.push({ kind: hit.kind, path, line: hit.line, ...assessSecret(path, hit) });
    files.set(path, {
      path,
      text: redacted.text,
      bytes: file.bytes.length,
      lineCount: countLines(redacted.text),
    });
  }
  const comment = result.globalHeaders.comment?.trim();
  return {
    ...coordinates,
    commit: comment !== undefined && /^[0-9a-f]{40}$/.test(comment) ? comment : null,
    files,
    skipped,
    secrets,
    lockfiles,
    entries: result.entries,
    compressedBytes: compressed.length,
    uncompressedBytes: result.uncompressedBytes,
    truncated: result.truncated,
  };
}
