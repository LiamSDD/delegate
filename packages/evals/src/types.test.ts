import { describe, expect, it } from "vitest";

import { EvalCaseSchema, ResultSchema, TrialSchema, summariseTrials, type Trial } from "./types";

const evalCase = {
  id: "xray-001",
  mission: "xray",
  version: 1,
  input: { company: "example.com" },
  checks: [
    { kind: "schema_valid" },
    { kind: "min_citations", min: 5 },
    { kind: "no_dead_links" },
    { kind: "max_cost_micro_usd", max: 0 },
    { kind: "max_latency_ms", max: 90_000 },
  ],
  rubric: [
    "Every claim about the company cites a source",
    "Recommendations are specific to the company",
  ],
  tags: ["saas", "small"],
};

function trial(index: number, score: number, passed: boolean): Trial {
  return TrialSchema.parse({
    caseId: "xray-001",
    mission: "xray",
    trialIndex: index,
    runId: `run_${index}`,
    promptVersions: { planner: 1, critic: 2 },
    serving: [
      { role: "planner", provider: "pollinations", model: "openai", calls: 1 },
      { role: "fast", provider: "llm7", model: "gpt-oss-20b", calls: 12 },
    ],
    startedAt: "2026-11-24T10:00:00.000Z",
    latencyMs: 60_000 + index * 1000,
    costMicroUsd: 0,
    score,
    passed,
    checks: [{ kind: "min_citations", passed, detail: "7 citations" }],
  });
}

describe("EvalCaseSchema", () => {
  it("accepts a well-formed case", () => {
    expect(EvalCaseSchema.parse(evalCase).id).toBe("xray-001");
  });

  it("rejects unknown checks and bad ids", () => {
    expect(() => EvalCaseSchema.parse({ ...evalCase, checks: [{ kind: "vibes" }] })).toThrow();
    expect(() => EvalCaseSchema.parse({ ...evalCase, id: "Has Spaces" })).toThrow();
  });
});

describe("TrialSchema", () => {
  it("requires the serving model and prompt versions", () => {
    expect(() => TrialSchema.parse({ ...trial(0, 1, true), serving: [] })).toThrow();
    expect(() =>
      TrialSchema.parse({ ...trial(0, 1, true), promptVersions: { planner: 0 } }),
    ).toThrow();
    expect(() => TrialSchema.parse({ ...trial(0, 1, true), costMicroUsd: 0.5 })).toThrow();
    expect(() => TrialSchema.parse({ ...trial(0, 1, true), score: 1.2 })).toThrow();
  });
});

describe("summariseTrials", () => {
  it("aggregates trials into a result with confidence intervals", () => {
    const result = summariseTrials([
      trial(0, 0.8, true),
      trial(1, 0.9, true),
      trial(2, 0.7, false),
    ]);
    expect(ResultSchema.parse(result)).toEqual(result);
    expect(result.caseId).toBe("xray-001");
    expect(result.promptVersions).toEqual({ planner: 1, critic: 2 });
    expect(result.score.mean).toBeCloseTo(0.8, 10);
    expect(result.score.lower).toBeCloseTo(0.8 - (4.302653 * 0.1) / Math.sqrt(3), 5);
    expect(result.passRate).toMatchObject({ rate: 2 / 3, n: 3 });
    expect(result.meanCostMicroUsd).toBe(0);
    expect(result.p50LatencyMs).toBe(61_000);
    expect(result.serving).toEqual([
      { role: "fast", provider: "llm7", model: "gpt-oss-20b", calls: 36 },
      { role: "planner", provider: "pollinations", model: "openai", calls: 3 },
    ]);
  });

  it("clamps the score interval to the [0, 1] score range", () => {
    const result = summariseTrials([trial(0, 0, false), trial(1, 1, true)]);
    expect(result.score.mean).toBe(0.5);
    expect(result.score.lower).toBe(0);
    expect(result.score.upper).toBe(1);
    const high = summariseTrials([trial(0, 1, true), trial(1, 0.98, true), trial(2, 1, true)]);
    expect(high.score.upper).toBe(1);
    expect(high.score.lower).toBeGreaterThan(0.9);
    expect(high.score.lower).toBeLessThan(high.score.mean);
  });

  it("refuses to mix cases or prompt versions", () => {
    expect(() =>
      summariseTrials([trial(0, 1, true), { ...trial(1, 1, true), caseId: "xray-002" }]),
    ).toThrow(/case/);
    expect(() =>
      summariseTrials([
        trial(0, 1, true),
        { ...trial(1, 1, true), promptVersions: { planner: 2, critic: 2 } },
      ]),
    ).toThrow(/prompt/);
  });

  it("requires at least two trials for an interval", () => {
    expect(() => summariseTrials([trial(0, 1, true)])).toThrow();
  });
});
