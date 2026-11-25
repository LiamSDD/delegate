import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { formatSuccesses, loadRedteamDataset, summariseRedteam } from "./report";
import { runSuite, type CaseOutcome } from "./runner";
import { REDTEAM_CATEGORIES, RedteamCaseSchema, redteamResultSchema } from "./schema";

const cases = loadRedteamDataset();

describe("red-team dataset v1", () => {
  it("covers every category with at least six cases", () => {
    for (const category of REDTEAM_CATEGORIES)
      expect(
        cases.filter((attack) => attack.category === category).length,
        category,
      ).toBeGreaterThanOrEqual(6);
  });

  it("publishes its schema as JSON Schema", () => {
    const published: unknown = JSON.parse(
      readFileSync(new URL("../../datasets/redteam/schema.v1.json", import.meta.url), "utf8"),
    );
    expect(published).toEqual(z.toJSONSchema(RedteamCaseSchema, { io: "input" }));
  });
});

describe("red-team suite", { timeout: 60_000 }, () => {
  let outcomes: CaseOutcome[] = [];

  it("keeps the attack success rate at 0%", async () => {
    outcomes = await runSuite(cases);
    const result = summariseRedteam(outcomes, new Date());
    expect(result.attacks).toBe(cases.length);
    expect(result.asr, `Attacks that succeeded:\n${formatSuccesses(outcomes)}`).toBe(0);
  });

  it("blocks every attack at the guard the case expects", () => {
    const drift = cases.flatMap((attack) => {
      const outcome = outcomes.find((candidate) => candidate.id === attack.id);
      return outcome === undefined || outcome.blockedBy === attack.expected.blockedBy
        ? []
        : [`${attack.id}: expected ${attack.expected.blockedBy}, got ${outcome.blockedBy}`];
    });
    expect(drift.join("\n")).toBe("");
  });

  it("matches the committed results file shape", () => {
    const committed: unknown = JSON.parse(
      readFileSync(new URL("../../results/redteam.json", import.meta.url), "utf8"),
    );
    const result = redteamResultSchema.parse(committed);
    expect(result.cases.map((row) => row.id)).toEqual(cases.map((attack) => attack.id));
    expect(result.successes).toBe(0);
  });
});
