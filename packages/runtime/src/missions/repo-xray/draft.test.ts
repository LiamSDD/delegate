import { describe, expect, it } from "vitest";

import {
  improvementFeedback,
  normaliseImprovements,
  pathHints,
  type ImprovementsDraftOutputSchema,
} from "./draft";
import { lineCitation, type Evidence } from "./evidence";
import { type RepoSnapshot } from "./snapshot";
import { type z } from "zod";

type DraftOutput = z.infer<typeof ImprovementsDraftOutputSchema>;

function snapshotOf(paths: readonly string[]): RepoSnapshot {
  return {
    owner: "sindresorhus",
    repo: "ky",
    ref: "HEAD",
    commit: null,
    files: new Map(
      paths.map((path) => [path, { path, text: "line\n", bytes: 5, lineCount: 1 }] as const),
    ),
    skipped: [],
    secrets: [],
    lockfiles: [],
    entries: paths.length,
    compressedBytes: 0,
    uncompressedBytes: 0,
    truncated: false,
  };
}

const KY_PATHS = [
  "package.json",
  "readme.md",
  "source/core/constants.ts",
  "source/core/Ky.ts",
  "source/errors/KyError.ts",
  "source/errors/TimeoutError.ts",
  "source/utils/is.ts",
  "source/types/standard-schema.ts",
  "source/types/ResponsePromise.ts",
  "test/hooks.ts",
  "test/retry.ts",
  "test/helpers/index.ts",
  "test-d/hooks.ts",
];

function evidenceOf(count: number): Map<string, Evidence> {
  return new Map(
    Array.from({ length: count }, (_, index) => {
      const id = `E${index + 1}`;
      const item: Evidence = {
        id,
        kind: "gap",
        citation: lineCitation(KY_PATHS[index % KY_PATHS.length] ?? "package.json", 1),
        text: "module has no test",
        trust: "derived",
      };
      return [id, item] as const;
    }),
  );
}

const untestedModule = (module: string, test: string, cite: string) => ({
  title: `Add unit tests for ${module}`,
  rationale: `${module} is imported but no test file covers it.`,
  cite: [cite],
  files: [test, `source/${module}`],
  kind: "test",
  effort: "S",
  acceptance: [`A test covers ${module}`],
});

describe("normaliseImprovements (ky gate run, 2026-11-25)", () => {
  const snapshot = snapshotOf(KY_PATHS);
  const evidence = evidenceOf(10);
  const kyDraft: DraftOutput = {
    improvements: [
      {
        title: "Rotate or remove secret-like value in test/hooks.ts",
        rationale: "A secret-like value was found committed in test/hooks.ts.",
        cite: ["E1"],
        files: ["test/hooks.ts"],
        kind: "security",
        effort: "S",
        acceptance: ["The secret-like value is removed"],
      },
      {
        ...untestedModule("core/constants.ts", "tests/test-constants.ts", "E2"),
        files: ["tests/test-constants.ts"],
      },
      { ...untestedModule("utils/is.ts", "tests/test-is.ts", "E3"), files: ["tests/test-is.ts"] },
      {
        ...untestedModule("errors/KyError.ts", "tests/test-ky-error.ts", "E4"),
        files: ["tests/test-ky-error.ts"],
      },
      {
        ...untestedModule("errors/TimeoutError.ts", "tests/test-timeout-error.ts", "E5"),
        files: ["tests/test-timeout-error.ts"],
      },
      {
        ...untestedModule("types/standard-schema.ts", "tests/test-standard-schema.ts", "E6"),
        files: ["tests/test-standard-schema.ts"],
      },
    ],
  };

  it("keeps new test files when the model pluralises an existing test directory", () => {
    const { improvements, issues } = normaliseImprovements(kyDraft, evidence, snapshot);
    expect(improvements).toHaveLength(6);
    expect(improvements[1]?.files).toEqual(["test/test-constants.ts"]);
    expect(issues.unknownFiles).toEqual([]);
  });

  it("accepts common spellings of kind, effort and single-string lists", () => {
    const { improvements, issues } = normaliseImprovements(
      {
        improvements: [
          { ...untestedModule("utils/is.ts", "test/is.ts", "E1"), kind: "Tests", effort: "small" },
          {
            ...untestedModule("core/Ky.ts", "test/ky.ts", "E2"),
            kind: "Bug-fix",
            effort: "Medium",
          },
          {
            ...untestedModule("core/Ky.ts", "test/ky2.ts", "E3"),
            acceptance: "npm test passes",
            cite: "E3",
          },
          {
            ...untestedModule("core/Ky.ts", "test/ky3.ts", "E4"),
            kind: "documentation",
            files: "readme.md",
          },
        ],
      },
      evidence,
      snapshot,
    );
    expect(improvements.map((improvement) => [improvement.kind, improvement.effort])).toEqual([
      ["test", "S"],
      ["bugfix", "M"],
      ["test", "S"],
      ["docs", "S"],
    ]);
    expect(issues.malformed).toBe(0);
  });

  it("says why a drafted item was discarded so the repair prompt can fix it", () => {
    const { improvements, issues } = normaliseImprovements(
      {
        improvements: [
          { ...untestedModule("core/Ky.ts", "test/ky.ts", "E1"), effort: "L" },
          { ...untestedModule("core/Ky.ts", "test/ky.ts", "E2"), kind: "performance" },
          {
            ...untestedModule("core/Ky.ts", "src/nowhere.ts", "E3"),
            kind: "refactor",
            files: ["src/nowhere.ts"],
          },
          { ...untestedModule("core/Ky.ts", "test/ky.ts", "E99") },
        ],
      },
      evidence,
      snapshot,
    );
    expect(improvements).toHaveLength(0);
    const feedback = improvementFeedback({ improvements, issues }, snapshot, 5);
    expect(feedback).toContain("0 improvements were kept; return 5 to 8");
    expect(feedback).toMatch(/effort/);
    expect(feedback).toMatch(/kind/);
    expect(feedback).toContain("src/nowhere.ts");
    expect(feedback).toContain("E99");
    expect(feedback).toContain("test/");
  });

  it("asks for nothing more once enough improvements survive", () => {
    const result = normaliseImprovements(kyDraft, evidence, snapshot);
    expect(improvementFeedback(result, snapshot, 5)).toBeUndefined();
  });

  it("lists the test directories and file paths the improver may name", () => {
    const hints = pathHints(snapshot, 50);
    expect(hints.testDirectories).toEqual(["test/", "test/helpers/"]);
    expect(hints.files).toContain("source/core/Ky.ts");
  });
});
