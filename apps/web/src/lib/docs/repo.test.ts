import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { findDocsRepoRoot } from "./repo";

describe("findDocsRepoRoot", () => {
  it("walks up from import.meta.dirname to the pnpm workspace root", () => {
    const root = findDocsRepoRoot([import.meta.dirname]);
    const workspaceFile = path.join(root, "pnpm-workspace.yaml");
    expect(existsSync(workspaceFile)).toBe(true);
    expect(readFileSync(workspaceFile, "utf8")).toContain("packages:");
  });

  it("skips undefined, empty, and unrelated candidates before finding the root", () => {
    const root = findDocsRepoRoot([undefined, "", "/", import.meta.dirname]);
    const workspaceFile = path.join(root, "pnpm-workspace.yaml");
    expect(existsSync(workspaceFile)).toBe(true);
    expect(readFileSync(workspaceFile, "utf8")).toContain("packages:");
  });

  it("throws an error mentioning DELEGATE_REPO_ROOT when no candidate contains the workspace", () => {
    expect(() => findDocsRepoRoot(["/"])).toThrow(/DELEGATE_REPO_ROOT/);
  });
});
