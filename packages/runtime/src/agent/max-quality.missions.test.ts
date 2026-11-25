import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

function sourceOf(mission: string): string {
  const folder = new URL(`../missions/${mission}/`, import.meta.url);
  return readdirSync(folder)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => readFileSync(new URL(name, folder), "utf8"))
    .join("\n");
}

const QUALITY_REQUEST = /\bquality:\s*\{\s*say\b/g;
const MODEL_CALL = /\b(callModel|callStructured|callStructuredReviewed|runAgentLoop)\(/;

describe("which missions ask for max quality (each asking mission has an end-to-end test in its run.test.ts)", () => {
  it.each([
    ["company-xray", 1],
    ["automation-audit", 1],
    ["build-agent", 1],
    ["repo-xray", 2],
    ["custom-goal", 1],
    ["ship-a-pr", 0],
    ["autopilot", 0],
  ])("%s makes %i quality-critical call(s)", (mission, expected) => {
    expect(sourceOf(mission).match(QUALITY_REQUEST)?.length ?? 0).toBe(expected);
  });

  it("Ship-a-PR has no design, ranking or synthesis step: its only model step is the Engineer's tool loop, which stays interactive", () => {
    const source = sourceOf("ship-a-pr");
    expect(source).toMatch(/runAgentLoop\(/);
    expect(source).not.toMatch(/callStructured(Reviewed)?\(/);
  });

  it("Autopilot makes no model call of its own; its children route their own steps", () => {
    expect(sourceOf("autopilot")).not.toMatch(MODEL_CALL);
  });
});
