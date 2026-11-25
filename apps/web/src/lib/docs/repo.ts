import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_MARKER = "pnpm-workspace.yaml";

function ascendToMarker(start: string): string | null {
  let current = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(current, ROOT_MARKER))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function findDocsRepoRoot(candidates: readonly (string | undefined)[]): string {
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === "") continue;
    const found = ascendToMarker(candidate);
    if (found !== null) return found;
  }
  throw new Error(`Could not find ${ROOT_MARKER} above the docs sources (set DELEGATE_REPO_ROOT)`);
}

let cachedRoot: string | undefined;

export function docsRepoRoot(): string {
  cachedRoot ??= findDocsRepoRoot([
    process.env.DELEGATE_REPO_ROOT,
    process.cwd(),
    path.dirname(fileURLToPath(import.meta.url)),
  ]);
  return cachedRoot;
}

export function isSafeRepoPath(relative: string): boolean {
  if (relative === "" || relative.startsWith("/") || relative.includes("\\")) return false;
  return relative
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function absolute(relative: string): string {
  if (!isSafeRepoPath(relative)) throw new Error(`Not a repository-relative path: ${relative}`);
  return path.join(/*turbopackIgnore: true*/ docsRepoRoot(), ...relative.split("/"));
}

export function repoFileExists(relative: string): boolean {
  return isSafeRepoPath(relative) && existsSync(absolute(relative));
}

export function readRepoText(relative: string): string {
  return readFileSync(absolute(relative), "utf8");
}

export function listRepoDir(relative: string): string[] {
  const directory = absolute(relative);
  if (!existsSync(directory)) return [];
  return readdirSync(directory).sort();
}
