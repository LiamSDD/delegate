import { describe, expect, it } from "vitest";

import { cohenKappaInterval } from "./judge/calibration";
import { EvalResultFileSchema, paretoFrontier, scoreboard, type ResultTrial } from "./results";

function trial(overrides: Partial<ResultTrial> = {}): ResultTrial {
  return {
    trial: 0,
    runId: "run",
    outcome: "completed",
    passed: true,
    score: 1,
    citationsVerified: true,
    judgeOverall: null,
    latencyMs: 1000,
    costMicroUsd: 0,
    tokens: 100,
    ...overrides,
  };
}

function file(trials: ResultTrial[]) {
  return EvalResultFileSchema.parse({
    version: 1,
    id: "2026-11-25T10-00-00-000Z",
    mission: "xray",
    mode: "live",
    dataset: { name: "company-xray", version: 1 },
    audience: "public-demo",
    startedAt: "2026-11-25T10:00:00.000Z",
    finishedAt: "2026-11-25T10:05:00.000Z",
    durationMs: 300_000,
    trialsPerCase: Math.max(1, trials.length),
    promptVersions: { "xray-judge": 1 },
    models: [],
    judgeModels: [],
    totals: { trials: trials.length, costMicroUsd: 0, tokens: 0 },
    cases: [{ caseId: "zed", company: "Zed", trials }],
    agreement: { status: "no_human_labels", labels: 0 },
  });
}

describe("scoreboard", () => {
  it("reports Wilson pass rate, citation accuracy over counted trials and median latency", () => {
    const board = scoreboard(
      file([
        trial({ latencyMs: 1000 }),
        trial({ passed: false, score: 0.5, citationsVerified: false, latencyMs: 3000 }),
        trial({ outcome: "errored", passed: false, score: 0, citationsVerified: null }),
      ]),
    );
    expect(board.trials).toBe(3);
    expect(board.passRate?.rate).toBeCloseTo(1 / 3);
    expect(board.passRate?.n).toBe(3);
    expect(board.citationAccuracy).toMatchObject({ rate: 0.5, n: 2 });
    expect(board.p50LatencyMs).toBe(1000);
    expect(board.score?.n).toBe(3);
    expect(board.judge).toBeNull();
  });

  it("returns null instead of numbers when there are no trials", () => {
    const board = scoreboard(file([]));
    expect(board.passRate).toBeNull();
    expect(board.score).toBeNull();
    expect(board.p50LatencyMs).toBeNull();
  });
});

describe("paretoFrontier", () => {
  it("keeps points no other point beats on both cost and quality", () => {
    const frontier = paretoFrontier([
      { id: "cheap", cost: 1, quality: 0.5 },
      { id: "best", cost: 5, quality: 0.9 },
      { id: "dominated", cost: 6, quality: 0.8 },
      { id: "tie", cost: 1, quality: 0.5 },
    ]);
    expect([...frontier].sort()).toEqual(["best", "cheap", "tie"]);
  });
});

describe("cohenKappaInterval", () => {
  it("brackets kappa with an asymptotic interval", () => {
    const interval = cohenKappaInterval([1, 2, 3, 4, 5, 3], [1, 2, 3, 4, 4, 3]);
    expect(interval?.kappa).toBeGreaterThan(0.5);
    expect(interval?.lower).toBeLessThan(interval?.kappa ?? 0);
    expect(interval?.upper).toBeGreaterThan(interval?.kappa ?? 1);
  });
});
