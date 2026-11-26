import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EvalResultFileSchema, wilsonInterval, type EvalResultFile } from "../results";
import {
  decideRouting,
  learnRouting,
  renderRouting,
  type ModelRef,
  type RoleChains,
  type RoutingSource,
} from "./learn";
import { LearnedRoutingSchema, type LearnedModel } from "./schema";
import { configuredChains, loadRoutingSources, runtimeMissionIds } from "./sources";

const A: ModelRef = { provider: "nvidia", model: "alpha" };
const B: ModelRef = { provider: "nvidia", model: "beta" };
const C: ModelRef = { provider: "nvidia", model: "gamma" };
const H: ModelRef = { provider: "nvidia", model: "head" };

type Serving = { role: "planner" | "worker" | "fast"; calls: number } & ModelRef;

interface TrialSpec {
  passed: boolean;
  serving?: Serving[];
  latencyMs?: number;
  errored?: boolean;
  historical?: boolean;
}

function served(model: ModelRef, passes: number, total: number, latencyMs = 10_000): TrialSpec[] {
  return Array.from({ length: total }, (_, index) => ({
    passed: index < passes,
    latencyMs: latencyMs + index,
    serving: [{ role: "worker", ...model, calls: 4 }],
  }));
}

let counter = 0;
function resultFile(
  specs: readonly TrialSpec[],
  patch: Partial<EvalResultFile> = {},
): RoutingSource {
  counter += 1;
  const id = `2026-11-25T10-00-0${counter % 10}-${String(counter).padStart(3, "0")}Z`;
  const file = EvalResultFileSchema.parse({
    version: 1,
    id,
    mission: "xray",
    mode: "live",
    dataset: { name: "company-xray", version: 1 },
    audience: "public-demo",
    startedAt: "2026-11-25T10:00:00.000Z",
    finishedAt: "2026-11-25T11:00:00.000Z",
    durationMs: 3_600_000,
    trialsPerCase: specs.length,
    promptVersions: { "company-xray-synthesis": 2 },
    models: [],
    judgeModels: [],
    totals: { trials: specs.length, costMicroUsd: 0, tokens: 0 },
    cases: [
      {
        caseId: "case-a",
        company: "Example",
        trials: specs.map((spec, trial) => ({
          trial,
          runId: `run-${trial}`,
          outcome: spec.errored === true ? "errored" : spec.passed ? "completed" : "failed",
          passed: spec.passed,
          score: spec.passed ? 1 : 0.5,
          citationsVerified: null,
          judgeOverall: null,
          latencyMs: spec.latencyMs ?? 10_000,
          costMicroUsd: 0,
          tokens: 100,
          ...(spec.historical === true ? {} : { hardFailures: [] }),
          ...(spec.serving === undefined || spec.historical === true
            ? {}
            : { serving: spec.serving }),
        })),
      },
    ],
    agreement: { status: "no_human_labels", labels: 0 },
    ...patch,
  });
  return { path: `packages/evals/results/${file.mission}/${id}.json`, file };
}

function chains(worker: readonly ModelRef[]): RoleChains {
  return { planner: worker, worker, fast: worker };
}

function learn(sources: readonly RoutingSource[], worker: readonly ModelRef[], minTrials = 20) {
  return learnRouting({
    sources,
    chains: chains(worker),
    missionIds: runtimeMissionIds(),
    minTrials,
    now: new Date("2026-11-26T09:00:00.000Z"),
  });
}

function workerEntry(routing: ReturnType<typeof learn>, mission = "company-xray") {
  const entry = routing.entries.find((row) => row.mission === mission && row.role === "worker");
  if (entry === undefined) throw new Error("expected a worker entry");
  return entry;
}

const model = (ref: ModelRef, passes: number, trials: number): LearnedModel => {
  const interval = wilsonInterval(passes, trials);
  return {
    ...ref,
    trials,
    passRate: interval.rate,
    ci: [interval.lower, interval.upper],
    p50LatencyMs: 1_000,
  };
};

describe("learnRouting", () => {
  it("learns an order when both models have enough trials and their intervals are apart", () => {
    const routing = learn(
      [resultFile([...served(A, 38, 40), ...served(B, 12, 30, 20_000)])],
      [A, B],
    );
    expect(LearnedRoutingSchema.parse(JSON.parse(JSON.stringify(routing)))).toEqual(routing);
    expect(routing).toMatchObject({
      version: 1,
      generatedAt: "2026-11-26T09:00:00.000Z",
      minTrials: 20,
      source: { trials: 70 },
    });
    expect(routing.source.resultFiles).toHaveLength(1);
    expect(routing.entries.map((entry) => `${entry.mission}:${entry.role}`)).toEqual([
      "company-xray:planner",
      "company-xray:worker",
      "company-xray:fast",
    ]);
    const entry = workerEntry(routing);
    expect(entry.decision).toBe("learned");
    const wilson = wilsonInterval(38, 40);
    expect(entry.order).toEqual([
      {
        ...A,
        trials: 40,
        passRate: 0.95,
        ci: [wilson.lower, wilson.upper],
        p50LatencyMs: 10_019.5,
      },
      expect.objectContaining({ ...B, trials: 30, passRate: 0.4, p50LatencyMs: 20_014.5 }),
    ]);
    expect(entry.reason).toMatch(/nvidia\/alpha \(n=40, 95% \[83, 99\]\) is above nvidia\/beta/);
    expect(routing.entries[0]).toMatchObject({
      decision: "insufficient-evidence",
      order: [],
      reason: "The planner role made no model call in 70 trials.",
    });
  });

  it("can put a later model first when everything configured ahead of it was measured", () => {
    const routing = learn([resultFile([...served(A, 10, 30), ...served(B, 39, 40)])], [A, B]);
    const entry = workerEntry(routing);
    expect(entry.decision).toBe("learned");
    expect(entry.order.map((row) => row.model)).toEqual(["beta", "alpha"]);
  });

  it("says insufficient evidence when the intervals overlap", () => {
    const entry = workerEntry(
      learn([resultFile([...served(A, 24, 30), ...served(B, 21, 30)])], [A, B]),
    );
    expect(entry.decision).toBe("insufficient-evidence");
    expect(entry.order.map((row) => row.model)).toEqual(["alpha", "beta"]);
    expect(entry.reason).toMatch(/are not separated: their intervals overlap/);
  });

  it("says insufficient evidence below the minimum number of trials, and honours --min-trials", () => {
    const sources = [resultFile([...served(A, 38, 40), ...served(B, 0, 5)])];
    const strict = workerEntry(learn(sources, [A, B]));
    expect(strict.decision).toBe("insufficient-evidence");
    expect(strict.reason).toMatch(/Only nvidia\/alpha .* has 20 attributed trials/);
    expect(strict.reason).toMatch(/below the minimum: nvidia\/beta \(n=5/);
    expect(strict.order.map((row) => `${row.model}:${row.trials}`)).toEqual(["alpha:40", "beta:5"]);
    expect(workerEntry(learn(sources, [A, B], 5)).decision).toBe("learned");
    const none = workerEntry(learn([resultFile(served(A, 3, 4))], [A, B]));
    expect(none.reason).toMatch(/No model has 20 attributed trials; the most observed is/);
  });

  it("does not move a model ahead of a configured model nobody measured", () => {
    const sources = [resultFile([...served(A, 39, 40), ...served(B, 10, 30)])];
    const blocked = workerEntry(learn(sources, [H, A, B]));
    expect(blocked.decision).toBe("insufficient-evidence");
    expect(blocked.reason).toMatch(
      /nvidia\/head is configured ahead of nvidia\/alpha and has no attributed trials \(minimum 20\)/,
    );
    const behind = workerEntry(learn(sources, [A, B, H]));
    expect(behind.decision).toBe("learned");
    expect(behind.order.map((row) => row.model)).toEqual(["alpha", "beta"]);
    const thinAhead = workerEntry(
      learn(
        [resultFile([...served(H, 2, 3), ...served(A, 39, 40), ...served(B, 10, 30)])],
        [H, A, B],
      ),
    );
    expect(thinAhead.decision).toBe("insufficient-evidence");
    expect(thinAhead.reason).toMatch(/nvidia\/head .* has only 3 attributed trials/);
  });

  it("lists only the models the evidence separates from everything below them", () => {
    const entry = workerEntry(
      learn(
        [resultFile([...served(A, 40, 40), ...served(B, 15, 30), ...served(C, 14, 30)])],
        [A, B, C],
      ),
    );
    expect(entry.decision).toBe("learned");
    expect(entry.order.map((row) => row.model)).toEqual(["alpha"]);
    expect(entry.reason).toMatch(/2 other observed models keep their configured order/);
    expect(entry.reason).toMatch(/beta .* and nvidia\/gamma .* are not separated/);
  });

  it("attributes a trial to the model with a majority of the role's calls and skips the rest", () => {
    const mixed: TrialSpec = {
      passed: true,
      serving: [
        { role: "worker", ...A, calls: 2 },
        { role: "worker", ...B, calls: 2 },
      ],
    };
    const majority: TrialSpec = {
      passed: false,
      serving: [
        { role: "worker", ...A, calls: 1 },
        { role: "worker", ...B, calls: 5 },
        { role: "planner", ...A, calls: 9 },
      ],
    };
    const errored: TrialSpec = {
      passed: false,
      errored: true,
      serving: [{ role: "worker", ...A, calls: 4 }],
    };
    const routing = learn(
      [resultFile([mixed, mixed, majority, errored, ...served(A, 3, 3)])],
      [A, B],
    );
    expect(routing.source.trials).toBe(6);
    const entry = workerEntry(routing);
    expect(entry.order.map((row) => `${row.model}:${row.trials}:${row.passRate}`)).toEqual([
      "alpha:3:1",
      "beta:1:0",
    ]);
    expect(entry.reason).toMatch(/2 trials were served by several models with no majority/);
    const planner = routing.entries.find((row) => row.role === "planner");
    expect(planner?.order.map((row) => `${row.model}:${row.trials}`)).toEqual(["alpha:1"]);
  });

  it("uses a historical file only when one model served the role, and never a replay", () => {
    const old = (passes: number, total: number): TrialSpec[] =>
      Array.from({ length: total }, (_, index) => ({ passed: index < passes, historical: true }));
    const single = resultFile(old(18, 20), {
      models: [{ role: "worker", ...A, calls: 80 }],
    });
    const several = resultFile(old(5, 10), {
      models: [
        { role: "worker", ...A, calls: 20 },
        { role: "worker", ...B, calls: 30 },
      ],
    });
    const replay = resultFile(served(B, 30, 30), { mode: "replay", replayOf: "earlier" });
    const routing = learn([single, several, replay], [A, B]);
    expect(routing.source.resultFiles).toEqual([single.path, several.path].sort());
    expect(routing.source.trials).toBe(30);
    const entry = workerEntry(routing);
    expect(entry.order.map((row) => `${row.model}:${row.trials}`)).toEqual(["alpha:20"]);
    expect(entry.decision).toBe("insufficient-evidence");
    expect(entry.reason).toMatch(
      /10 trials from result files without per-trial serving could not be attributed/,
    );
  });

  it("keeps missions apart and uses runtime mission ids", () => {
    const xray = resultFile([...served(A, 38, 40), ...served(B, 12, 30)]);
    const goal = resultFile([...served(A, 10, 30), ...served(B, 39, 40)], { mission: "goal" });
    const routing = learn([xray, goal], [A, B]);
    expect(workerEntry(routing, "company-xray").order[0]?.model).toBe("alpha");
    expect(workerEntry(routing, "custom-goal").order[0]?.model).toBe("beta");
    expect(renderRouting(routing)).toMatch(/custom-goal worker: learned/);
  });

  it("does not rank a model the configuration no longer lists for the role", () => {
    const decision = decideRouting(
      [model(A, 38, 40), model(B, 12, 30), model(C, 30, 30)],
      [A, B],
      20,
    );
    expect(decision.decision).toBe("learned");
    expect(decision.order.map((row) => row.model)).toEqual(["alpha", "beta"]);
    expect(decision.reason).toMatch(/no longer lists it for this role: nvidia\/gamma/);
  });
});

describe("routing schema and sources", () => {
  const valid = {
    version: 1,
    generatedAt: "2026-11-26T09:00:00.000Z",
    source: { resultFiles: ["a.json"], trials: 1 },
    minTrials: 20,
    entries: [
      {
        mission: "company-xray",
        role: "worker",
        order: [{ ...A, trials: 1, passRate: 1, ci: [0.2, 1], p50LatencyMs: null }],
        decision: "insufficient-evidence",
        reason: "r",
      },
    ],
  };

  it("is strict the same way the runtime schema is", () => {
    expect(LearnedRoutingSchema.safeParse(valid).success).toBe(true);
    const entry = valid.entries[0];
    const bad = [
      { ...valid, extra: true },
      { ...valid, entries: [entry, entry] },
      {
        ...valid,
        entries: [{ ...entry, order: [...(entry?.order ?? []), ...(entry?.order ?? [])] }],
      },
      { ...valid, entries: [{ ...entry, order: [{ ...entry?.order[0], ci: [0.9, 0.1] }] }] },
      { ...valid, entries: [{ ...entry, order: [{ ...entry?.order[0], passRate: 1.2 }] }] },
      { ...valid, entries: [{ ...entry, decision: "maybe" }] },
      { ...valid, entries: [{ ...entry, role: "judge" }] },
    ];
    for (const candidate of bad)
      expect(LearnedRoutingSchema.safeParse(candidate).success).toBe(false);
  });

  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("reads result files per mission from disk and ignores files that do not parse", () => {
    const dir = mkdtempSync(join(tmpdir(), "route-learn-"));
    dirs.push(dir);
    const source = resultFile(served(A, 2, 2));
    mkdirSync(join(dir, "xray"), { recursive: true });
    writeFileSync(join(dir, "xray", `${source.file.id}.json`), JSON.stringify(source.file));
    writeFileSync(join(dir, "xray", "broken.json"), "{");
    writeFileSync(join(dir, "redteam.json"), "{}");
    expect(loadRoutingSources(dir).map((entry) => entry.path)).toEqual([source.path]);
    expect(loadRoutingSources(join(dir, "missing"))).toEqual([]);
  });

  it("takes the configured order per role from config/models.json", () => {
    const configured = configuredChains();
    for (const role of ["planner", "worker", "fast"] as const) {
      expect(configured[role].length).toBeGreaterThan(0);
      expect(new Set(configured[role].map((m) => `${m.provider}/${m.model}`)).size).toBe(
        configured[role].length,
      );
    }
  });
});
