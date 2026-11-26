import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SOURCE = path.join(import.meta.dirname, "..");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx") ? [full] : [];
  });
}

function gridsWithoutMobileTrack(source: string): string[] {
  return [...source.matchAll(/"([^"]*)"/g)]
    .map((match) => match[1] ?? "")
    .filter((value) => {
      const classes = value.split(/\s+/);
      return (
        classes.includes("grid") &&
        classes.some((name) => /^(?:sm|md|lg|xl|2xl):grid-cols-/.test(name)) &&
        !classes.some((name) => name.startsWith("grid-cols-"))
      );
    });
}

describe("responsive grids", () => {
  it("spots a grid whose phone column would grow to fit unbreakable text", () => {
    expect(gridsWithoutMobileTrack('<div className="grid gap-6 md:grid-cols-2">')).toHaveLength(1);
    expect(gridsWithoutMobileTrack('<div className="grid grid-cols-1 md:grid-cols-2">')).toEqual(
      [],
    );
    expect(gridsWithoutMobileTrack('<div className="md:grid md:grid-cols-2">')).toEqual([]);
  });

  it("declare a shrinkable single column on phones", () => {
    const offenders = sourceFiles(SOURCE).flatMap((file) =>
      gridsWithoutMobileTrack(readFileSync(file, "utf8")).map(
        (value) => `${path.relative(SOURCE, file)}: ${value}`,
      ),
    );
    expect(offenders).toEqual([]);
  });
});
