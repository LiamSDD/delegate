import { describe, expect, it } from "vitest";

import { listRepoDir, readRepoText, repoFileExists } from "./repo";

const COMPONENTS = "apps/web/src/components/docs";
const LIBRARY = "apps/web/src/lib/docs";
const SERVER_ONLY = ["marked", "node:fs", "node:path", `${LIBRARY}/repo`, `${LIBRARY}/markdown`];

function runtimeImports(source: string): string[] {
  const specifiers: string[] = [];
  const statement =
    /^(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s+"([^"]+)";|^import\s+"([^"]+)";/gm;
  for (const match of source.matchAll(statement)) specifiers.push(match[1] ?? match[2] ?? "");
  return specifiers;
}

function resolveSpecifier(from: string, specifier: string): string {
  if (specifier.startsWith("@/")) return `apps/web/src/${specifier.slice(2)}`;
  if (!specifier.startsWith(".")) return specifier;
  const segments = from.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === ".") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return segments.join("/");
}

function sourceFile(target: string): string | null {
  return [`${target}.ts`, `${target}.tsx`].find((file) => repoFileExists(file)) ?? null;
}

function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    for (const specifier of runtimeImports(readRepoText(file))) {
      const target = resolveSpecifier(file, specifier);
      seen.add(target);
      const next = target.startsWith("apps/web/src/") ? sourceFile(target) : null;
      if (next !== null) queue.push(next);
    }
  }
  return seen;
}

describe("docs client components", () => {
  const clientFiles = listRepoDir(COMPONENTS)
    .filter((file) => file.endsWith(".tsx") && !file.endsWith(".test.tsx"))
    .map((file) => `${COMPONENTS}/${file}`)
    .filter((file) => readRepoText(file).startsWith('"use client";'));

  it("finds the interactive parts of the shell", () => {
    expect(clientFiles.map((file) => file.slice(COMPONENTS.length + 1))).toEqual([
      "api-reference.tsx",
      "copy-button.tsx",
      "docs-frame.tsx",
      "docs-nav.tsx",
      "docs-search.tsx",
      "docs-toc.tsx",
    ]);
  });

  it.each(clientFiles)("%s ships no Markdown parser and no file access to the browser", (file) => {
    const reached = reachableFrom(file);
    for (const forbidden of SERVER_ONLY) expect(reached, forbidden).not.toContain(forbidden);
  });

  it("would notice a client component that imported the parser", () => {
    expect(
      runtimeImports('import { Marked } from "marked";\nimport type { A } from "./a";'),
    ).toEqual(["marked"]);
    expect(reachableFrom(`${COMPONENTS}/markdown.tsx`)).toContain(`${LIBRARY}/markdown`);
    expect(reachableFrom(`${LIBRARY}/markdown.ts`)).toContain("marked");
  });
});
