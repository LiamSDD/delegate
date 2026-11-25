import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { type CaseOutcome } from "./runner";
import {
  REDTEAM_CATEGORIES,
  REDTEAM_SUITE,
  RedteamCaseSchema,
  redteamResultSchema,
  type RedteamCase,
  type RedteamResult,
} from "./schema";

export const REDTEAM_DATASET_PATH = fileURLToPath(
  new URL("../../datasets/redteam/v1.jsonl", import.meta.url),
);

export function parseRedteamDataset(text: string): RedteamCase[] {
  const cases = text
    .split("\n")
    .map((line, index) => ({ line: line.trim(), index }))
    .filter(({ line }) => line !== "")
    .map(({ line, index }) => {
      const parsed = RedteamCaseSchema.safeParse(JSON.parse(line));
      if (!parsed.success)
        throw new Error(`redteam/v1.jsonl line ${index + 1}: ${parsed.error.message}`);
      return parsed.data;
    });
  const ids = new Set<string>();
  for (const attack of cases) {
    if (ids.has(attack.id)) throw new Error(`Duplicate red-team case id ${attack.id}`);
    ids.add(attack.id);
  }
  return cases;
}

export function loadRedteamDataset(path = REDTEAM_DATASET_PATH): RedteamCase[] {
  return parseRedteamDataset(readFileSync(path, "utf8"));
}

export function summariseRedteam(
  outcomes: readonly CaseOutcome[],
  generatedAt: Date,
): RedteamResult {
  const successes = outcomes.filter((outcome) => outcome.succeeded).length;
  const categories = [
    ...REDTEAM_CATEGORIES,
    ...new Set(outcomes.map((outcome) => outcome.category)),
  ].filter((category, index, all) => all.indexOf(category) === index);
  return redteamResultSchema.parse({
    version: 1,
    generatedAt: generatedAt.toISOString(),
    suite: REDTEAM_SUITE,
    attacks: outcomes.length,
    successes,
    asr: outcomes.length === 0 ? 0 : successes / outcomes.length,
    byCategory: categories
      .map((category) => {
        const inCategory = outcomes.filter((outcome) => outcome.category === category);
        return {
          category,
          attacks: inCategory.length,
          successes: inCategory.filter((outcome) => outcome.succeeded).length,
        };
      })
      .filter((row) => row.attacks > 0),
    cases: outcomes.map(({ id, category, blockedBy, succeeded }) => ({
      id,
      category,
      blockedBy,
      succeeded,
    })),
  });
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : `${text}${" ".repeat(width - text.length)}`;
}

export function formatRedteamTable(result: RedteamResult): string {
  const rows = [
    ["category", "attacks", "successes", "asr"],
    ...result.byCategory.map((row) => [
      row.category,
      String(row.attacks),
      String(row.successes),
      `${((row.successes / row.attacks) * 100).toFixed(1)}%`,
    ]),
    [
      "total",
      String(result.attacks),
      String(result.successes),
      `${(result.asr * 100).toFixed(1)}%`,
    ],
  ];
  const widths = [0, 1, 2, 3].map((column) =>
    Math.max(...rows.map((row) => (row[column] ?? "").length)),
  );
  return rows
    .map((row) => row.map((cell, column) => pad(cell, widths[column] ?? 0)).join("  "))
    .join("\n");
}

export function formatSuccesses(outcomes: readonly CaseOutcome[]): string {
  return outcomes
    .filter((outcome) => outcome.succeeded)
    .map((outcome) => `${outcome.id} (${outcome.category}): ${outcome.evidence.join("; ")}`)
    .join("\n");
}
