import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const appDir = path.join(import.meta.dirname, "..", "app");

function pageFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return pageFiles(full);
    return entry.name === "page.tsx" ? [full] : [];
  });
}

describe("HTML pages and the nonce-based CSP", () => {
  it("never prerender a page, because a prerendered page carries no per-request script nonce", () => {
    const forced = pageFiles(appDir)
      .filter((file) =>
        /export const dynamic\s*=\s*["']force-static["']/.test(readFileSync(file, "utf8")),
      )
      .map((file) => path.relative(appDir, file));
    expect(forced).toEqual([]);
  });
});
