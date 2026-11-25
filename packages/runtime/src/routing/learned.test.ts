import { describe, expect, it } from "vitest";

import { parseModelsConfig, resolveChain, type ChainContext } from "../models";
import {
  LearnedRoutingSchema,
  applyLearnedOrder,
  leadWithOfflineEntry,
  learnedEntryFor,
  parseLearnedRouting,
  type LearnedRouting,
} from "./learned";

const model = (provider: string, name: string, passRate = 0.9) => ({
  provider,
  model: name,
  trials: 40,
  passRate,
  ci: [0.77, 0.96] as [number, number],
  p50LatencyMs: 8200,
});

const file = (entries: LearnedRouting["entries"]): LearnedRouting => ({
  version: 1,
  generatedAt: "2026-11-25T10:00:00.000Z",
  source: { resultFiles: ["packages/evals/results/xray/2026-11-25.json"], trials: 120 },
  minTrials: 20,
  entries,
});

const config = parseModelsConfig({
  version: 1,
  providers: [
    {
      id: "keyed",
      kind: "openai-compatible",
      baseUrl: "https://keyed.test/v1",
      apiKeyEnv: "KEYED_API_KEY",
      keyless: false,
      terms: "public-demo-ok",
      maxClassification: "public",
      dataPolicy: "x",
    },
    {
      id: "owner-only",
      kind: "openai-compatible",
      baseUrl: "https://owner.test/v1",
      keyless: true,
      terms: "evaluation-only",
      maxClassification: "public",
      dataPolicy: "x",
    },
    {
      id: "free",
      kind: "openai-compatible",
      baseUrl: "https://free.test/v1",
      keyless: true,
      terms: "public-demo-ok",
      maxClassification: "public",
      dataPolicy: "x",
    },
  ],
  roles: {
    planner: [
      {
        provider: "free",
        model: "slow",
        contextWindow: 8000,
        supportsTools: true,
        interactive: false,
      },
      { provider: "free", model: "a", contextWindow: 8000, supportsTools: true },
      { provider: "keyed", model: "k", contextWindow: 8000, supportsTools: true },
      { provider: "free", model: "b", contextWindow: 8000, supportsTools: true },
      { provider: "owner-only", model: "o", contextWindow: 8000, supportsTools: true },
      { provider: "free", model: "c", contextWindow: 8000, supportsTools: true },
    ],
    worker: [{ provider: "free", model: "a", contextWindow: 8000, supportsTools: true }],
    fast: [{ provider: "free", model: "a", contextWindow: 8000, supportsTools: true }],
  },
});

const context = (overrides: Partial<ChainContext> = {}): ChainContext => ({
  config,
  audience: "owner",
  environment: "server",
  classification: "public",
  ...overrides,
});

const names = (chain: readonly { model: string }[]) => chain.map((entry) => entry.model);

describe("LearnedRoutingSchema", () => {
  it("accepts the documented file shape", () => {
    const routing = file([
      {
        mission: "company-xray",
        role: "worker",
        order: [
          model("nvidia", "minimaxai/minimax-m3.1-flash"),
          { ...model("free", "a"), p50LatencyMs: null },
        ],
        decision: "learned",
        reason: "40 trials each; the interval of the first model is above the second.",
      },
      {
        mission: "custom-goal",
        role: "fast",
        order: [],
        decision: "insufficient-evidence",
        reason: "",
      },
    ]);
    expect(LearnedRoutingSchema.parse(routing)).toEqual(routing);
  });

  it.each([
    ["an unknown top-level key", { ...file([]), extra: true }, /extra|Unrecognized/i],
    ["another version", { ...file([]), version: 2 }, /version/],
    ["a date that is not ISO-8601", { ...file([]), generatedAt: "yesterday" }, /generatedAt/],
    [
      "an unknown role",
      file([{ mission: "m", role: "judge" as never, order: [], decision: "learned", reason: "" }]),
      /role/,
    ],
    [
      "an unknown decision",
      file([{ mission: "m", role: "fast", order: [], decision: "maybe" as never, reason: "" }]),
      /decision/,
    ],
    [
      "a pass rate above 1",
      file([
        {
          mission: "m",
          role: "fast",
          order: [model("free", "a", 1.2)],
          decision: "learned",
          reason: "",
        },
      ]),
      /passRate/,
    ],
    [
      "an interval whose lower bound is above its upper bound",
      file([
        {
          mission: "m",
          role: "fast",
          order: [{ ...model("free", "a"), ci: [0.9, 0.5] }],
          decision: "learned",
          reason: "",
        },
      ]),
      /ci/,
    ],
    [
      "one model listed twice",
      file([
        {
          mission: "m",
          role: "fast",
          order: [model("free", "a"), model("free", "a")],
          decision: "learned",
          reason: "",
        },
      ]),
      /listed twice/,
    ],
    [
      "two entries for one mission and role",
      file([
        { mission: "m", role: "fast", order: [], decision: "learned", reason: "" },
        { mission: "m", role: "fast", order: [], decision: "insufficient-evidence", reason: "" },
      ]),
      /Two entries/,
    ],
  ])("rejects %s", (_label, input, reason) => {
    const parsed = parseLearnedRouting(input);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(reason);
  });
});

describe("learnedEntryFor", () => {
  const routing = file([
    {
      mission: "company-xray",
      role: "planner",
      order: [model("free", "c")],
      decision: "learned",
      reason: "",
    },
    {
      mission: "company-xray",
      role: "worker",
      order: [model("free", "c")],
      decision: "insufficient-evidence",
      reason: "12 trials, 20 needed",
    },
  ]);

  it("finds the learned entry of the run's mission and the call's role", () => {
    expect(learnedEntryFor(routing, "company-xray", "planner")?.order[0]?.model).toBe("c");
  });

  it("returns nothing for another mission, another role, weak evidence, no mission or no file", () => {
    expect(learnedEntryFor(routing, "custom-goal", "planner")).toBeUndefined();
    expect(learnedEntryFor(routing, "company-xray", "fast")).toBeUndefined();
    expect(learnedEntryFor(routing, "company-xray", "worker")).toBeUndefined();
    expect(learnedEntryFor(routing, undefined, "planner")).toBeUndefined();
    expect(learnedEntryFor(undefined, "company-xray", "planner")).toBeUndefined();
  });
});

describe("applyLearnedOrder", () => {
  const interactive = resolveChain("planner", { KEYED_API_KEY: "k" }, context());

  it("keeps the configured order without an entry", () => {
    expect(names(interactive)).toEqual(["a", "k", "b", "o", "c"]);
    expect(applyLearnedOrder(interactive, undefined)).toEqual({
      chain: interactive,
      ordering: "configured",
    });
  });

  it("puts the listed models first in the listed order and keeps the rest in configured order", () => {
    const ordered = applyLearnedOrder(interactive, {
      order: [model("free", "c"), model("keyed", "k")],
    });
    expect(names(ordered.chain)).toEqual(["c", "k", "a", "b", "o"]);
    expect(ordered.ordering).toBe("learned");
  });

  it("ignores a model that the configuration does not list for the role", () => {
    const ordered = applyLearnedOrder(interactive, {
      order: [model("free", "not-configured"), model("elsewhere", "a"), model("free", "b")],
    });
    expect(names(ordered.chain)).toEqual(["b", "a", "k", "o", "c"]);
  });

  it("reports the configured order when no listed model is in the chain", () => {
    const ordered = applyLearnedOrder(interactive, { order: [model("free", "not-configured")] });
    expect(names(ordered.chain)).toEqual(["a", "k", "b", "o", "c"]);
    expect(ordered.ordering).toBe("configured");
  });

  it("never brings an offline-latency entry into an interactive call", () => {
    const ordered = applyLearnedOrder(interactive, {
      order: [model("free", "slow"), model("free", "b")],
    });
    expect(names(ordered.chain)).toEqual(["b", "a", "k", "o", "c"]);
    expect(ordered.chain.every((entry) => entry.interactive)).toBe(true);
  });

  it("orders an offline-latency entry like any other in an offline call", () => {
    const offline = resolveChain("planner", {}, context({ latency: "offline" }));
    expect(names(offline)).toEqual(["slow", "a", "b", "o", "c"]);
    const ordered = applyLearnedOrder(offline, {
      order: [model("free", "b"), model("free", "slow")],
    });
    expect(names(ordered.chain)).toEqual(["b", "slow", "a", "o", "c"]);
  });

  it("cannot add a provider without a key or one the audience may not use", () => {
    const demo = resolveChain("planner", {}, context({ audience: "public-demo" }));
    expect(names(demo)).toEqual(["a", "b", "c"]);
    const ordered = applyLearnedOrder(demo, {
      order: [model("owner-only", "o"), model("keyed", "k"), model("free", "c")],
    });
    expect(names(ordered.chain)).toEqual(["c", "a", "b"]);
  });
});

describe("leadWithOfflineEntry", () => {
  const offline = resolveChain("planner", {}, context({ latency: "offline" }));

  it("moves the first offline-latency entry to the head and keeps the rest in order", () => {
    const learned = applyLearnedOrder(offline, { order: [model("free", "c"), model("free", "a")] });
    expect(names(learned.chain)).toEqual(["c", "a", "slow", "b", "o"]);
    expect(names(leadWithOfflineEntry(learned.chain))).toEqual(["slow", "c", "a", "b", "o"]);
  });

  it("leaves a chain alone when it already leads with one or has none", () => {
    expect(names(leadWithOfflineEntry(offline))).toEqual(names(offline));
    const interactive = resolveChain("planner", {}, context());
    expect(names(leadWithOfflineEntry(interactive))).toEqual(names(interactive));
  });
});
