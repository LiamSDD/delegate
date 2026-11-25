import { posix } from "node:path";

import { type Sandbox } from "./types";

export const PATH_ERROR_CODES = [
  "path_invalid",
  "path_escape",
  "path_protected",
  "file_too_large",
] as const;
export type PathErrorCode = (typeof PATH_ERROR_CODES)[number];

export class SandboxPathError extends Error {
  override readonly name = "SandboxPathError";
  constructor(
    readonly code: PathErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export const MAX_REPO_PATH_CHARS = 400;

const PROTECTED_PREFIXES = [".github/workflows/", ".github/actions/", ".circleci/", ".husky/"];
const PROTECTED_FILES = new Set([
  ".gitlab-ci.yml",
  ".gitmodules",
  ".travis.yml",
  "azure-pipelines.yml",
]);

export function normaliseRepoPath(raw: string): string {
  const text = raw.trim();
  if (text.length > MAX_REPO_PATH_CHARS)
    throw new SandboxPathError("path_invalid", "The path is too long");
  if (/[\0\r\n]/.test(text) || text.includes("\\"))
    throw new SandboxPathError("path_invalid", "The path contains a forbidden character");
  if (text.startsWith("/") || text.startsWith("~") || /^[A-Za-z]:/.test(text))
    throw new SandboxPathError("path_escape", "Paths must be relative to the repository root");
  const segments = text.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes(".."))
    throw new SandboxPathError("path_escape", "Paths may not leave the repository root");
  if (segments.some((segment) => segment.toLowerCase() === ".git"))
    throw new SandboxPathError("path_protected", "The .git directory is off limits");
  return segments.join("/");
}

export function isProtectedPath(relative: string): boolean {
  const lower = relative.toLowerCase();
  if (PROTECTED_FILES.has(lower)) return true;
  return PROTECTED_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

export function isInside(root: string, candidate: string): boolean {
  const relative = posix.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !posix.isAbsolute(relative));
}

export interface ConfinedPath {
  relative: string;
  absolute: string;
}

export async function confinePath(
  sandbox: Sandbox,
  raw: string,
  mode: "read" | "write",
): Promise<ConfinedPath> {
  const relative = normaliseRepoPath(raw);
  if (mode === "write" && relative === "")
    throw new SandboxPathError("path_invalid", "Name a file to write");
  if (mode === "write" && isProtectedPath(relative))
    throw new SandboxPathError(
      "path_protected",
      `${relative} is a CI or repository configuration file the Engineer may not change`,
    );
  const root = await sandbox.resolve(sandbox.repoDir);
  const resolved = await sandbox.resolve(posix.join(sandbox.repoDir, relative));
  if (!isInside(root, resolved))
    throw new SandboxPathError("path_escape", `${relative} resolves outside the repository`);
  const inner = posix.relative(root, resolved);
  if (inner.split("/").some((segment) => segment.toLowerCase() === ".git"))
    throw new SandboxPathError("path_protected", "The .git directory is off limits");
  if (mode === "write" && isProtectedPath(inner))
    throw new SandboxPathError("path_protected", `${inner} is a protected file`);
  return { relative, absolute: resolved };
}
