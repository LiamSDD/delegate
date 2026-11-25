import { defaultPolicy } from "@delegate/policy";
import { describe, expect, it } from "vitest";

import { createRunContext } from "../agent/context";
import { createRunEmitter } from "../agent/emitter";
import { callModel } from "../agent/model-call";
import { chainHead } from "../agent/pacing";
import { Budget } from "../budget";
import { type ModelFallbackPayload, type RunEventDraft } from "../events";
import { parseModelsConfig } from "../models";
import {
  ProviderHttpError,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
} from "../providers/types";
import { ModelRouter, type RouterRequest } from "../router";
import { textTurn } from "../testing/fakes";
import { type LearnedRouting } from "./learned";

const config = parseModelsConfig({
  version: 1,
  providers: [
    {
      id: "p",
      kind: "openai-compatible",
      baseUrl: "https://p.test/v1",
      keyless: true,
      terms: "public-demo-ok",
      maxClassification: "public",
      dataPolicy: "x",
    },
  ],
  roles: {
    planner: [
      {
        provider: "p",
        model: "slow",
        contextWindow: 8000,
        supportsTools: true,
        interactive: false,
      },
      { provider: "p", model: "a", contextWindow: 8000, supportsTools: true },
      { provider: "p", model: "b", contextWindow: 8000, supportsTools: true },
      { provider: "p", model: "c", contextWindow: 8000, supportsTools: true },
    ],
    worker: [
      { provider: "p", model: "a", contextWindow: 8000, supportsTools: true },
      { provider: "p", model: "b", contextWindow: 8000, supportsTools: true },
      {
        provider: "p",
        model: "slow",
        contextWindow: 8000,
        supportsTools: true,
        interactive: false,
      },
    ],
    fast: [{ provider: "p", model: "a", contextWindow: 8000, supportsTools: true }],
  },
});

const listed = (model: string) => ({
  provider: "p",
  model,
  trials: 30,
  passRate: 0.9,
  ci: [0.75, 0.97] as [number, number],
  p50LatencyMs: null,
});

const learned: LearnedRouting = {
  version: 1,
  generatedAt: "2026-11-25T10:00:00Z",
  source: { resultFiles: ["packages/evals/results/xray.json"], trials: 90 },
  minTrials: 20,
  entries: [
    {
      mission: "company-xray",
      role: "planner",
      order: [listed("c"), listed("slow"), listed("not-configured")],
      decision: "learned",
      reason: "c passed more often than a and b",
    },
    {
      mission: "company-xray",
      role: "worker",
      order: [listed("b")],
      decision: "insufficient-evidence",
      reason: "12 trials, 20 needed",
    },
  ],
};

const request: RouterRequest = {
  system: "s",
  messages: [{ role: "user", content: "u" }],
  maxTokens: 100,
};

function provider(failing: ReadonlySet<string> = new Set()) {
  const calls: ModelRequest[] = [];
  const fake: ModelProvider = {
    id: "p",
    async *stream(req): AsyncGenerator<ModelStreamEvent> {
      calls.push(req);
      await Promise.resolve();
      if (failing.has(req.model)) throw new ProviderHttpError("p", 503, "down");
      yield* textTurn(req.model);
    },
  };
  return { fake, calls };
}

function router(options: { mission?: string; learned?: LearnedRouting; failing?: string[] }) {
  const { fake, calls } = provider(new Set(options.failing ?? []));
  const fallbacks: ModelFallbackPayload[] = [];
  const built = new ModelRouter({
    env: {},
    context: { config, audience: "owner", environment: "server", classification: "public" },
    createProvider: () => fake,
    emitFallback: (payload) => fallbacks.push(payload),
    ...(options.mission === undefined ? {} : { mission: options.mission }),
    ...(options.learned === undefined ? {} : { learned: options.learned }),
  });
  return { router: built, calls, fallbacks };
}

const models = (chain: readonly { model: string }[]) => chain.map((entry) => entry.model);

describe("ModelRouter with learned routing", () => {
  it("behaves exactly as configured without a learned file", async () => {
    const { router: plain, fallbacks } = router({ mission: "company-xray" });
    expect(models(plain.chain("planner"))).toEqual(["a", "b", "c"]);
    const routed = await plain.open("planner", request);
    expect(routed).toMatchObject({ model: "a", ordering: "configured" });
    expect(fallbacks).toEqual([]);
  });

  it("serves the learned head for the run's mission and the call's role", async () => {
    const { router: taught } = router({ mission: "company-xray", learned });
    expect(models(taught.chain("planner"))).toEqual(["c", "a", "b"]);
    expect(await taught.open("planner", request)).toMatchObject({
      model: "c",
      ordering: "learned",
    });
  });

  it("keeps the configured order for another mission, a run without a mission and weak evidence", async () => {
    const other = router({ mission: "custom-goal", learned });
    expect(await other.router.open("planner", request)).toMatchObject({
      model: "a",
      ordering: "configured",
    });
    const none = router({ learned });
    expect(await none.router.open("planner", request)).toMatchObject({
      model: "a",
      ordering: "configured",
    });
    const weak = router({ mission: "company-xray", learned });
    expect(await weak.router.open("worker", request)).toMatchObject({
      model: "a",
      ordering: "configured",
    });
  });

  it("never promotes an offline-latency entry into an interactive call", () => {
    const { router: taught } = router({ mission: "company-xray", learned });
    const interactive = taught.chain("planner");
    expect(models(interactive)).not.toContain("slow");
    expect(models(taught.chain("planner", { latency: "offline" }))).toEqual([
      "c",
      "slow",
      "a",
      "b",
    ]);
  });

  it("records the ordering on every fallback of a learned chain", async () => {
    const { router: taught, fallbacks } = router({
      mission: "company-xray",
      learned,
      failing: ["c"],
    });
    expect(await taught.open("planner", request)).toMatchObject({
      model: "a",
      ordering: "learned",
    });
    expect(fallbacks).toEqual([
      {
        role: "planner",
        from: { provider: "p", model: "c" },
        to: { provider: "p", model: "a" },
        reason: "server_error",
        ordering: "learned",
      },
    ]);
  });

  it("leads with the role's first offline entry when asked, whatever was learned", () => {
    const { router: taught } = router({ mission: "company-xray", learned });
    expect(models(taught.chain("planner", { latency: "offline", leadWithOffline: true }))).toEqual([
      "slow",
      "c",
      "a",
      "b",
    ]);
    expect(models(taught.chain("worker", { latency: "offline", leadWithOffline: true }))).toEqual([
      "slow",
      "a",
      "b",
    ]);
    expect(models(taught.chain("worker", { leadWithOffline: true }))).toEqual(["a", "b"]);
  });
});

describe("attribution in model events", () => {
  function run(mission: string | undefined) {
    const { fake } = provider();
    const events: RunEventDraft[] = [];
    const ctx = createRunContext({
      runId: "run_1",
      workspaceId: "ws",
      audience: "owner",
      classification: "public",
      config,
      env: {},
      emitter: createRunEmitter((event) => {
        events.push(event);
        return Promise.resolve();
      }),
      budget: new Budget({ run: { maxTokens: 100_000, maxMicroUsd: 0 } }),
      policies: [defaultPolicy],
      createProvider: () => fake,
      learnedRouting: learned,
      ...(mission === undefined ? {} : { missionId: mission }),
    });
    return { ctx, events };
  }

  it("names the role and the learned ordering in usage.updated", async () => {
    const { ctx, events } = run("company-xray");
    const result = await callModel(ctx, { role: "planner", stepId: "synthesise", request });
    expect(result.model).toBe("c");
    expect(events[0]).toMatchObject({
      type: "usage.updated",
      stepId: "synthesise",
      payload: { provider: "p", model: "c", role: "planner", ordering: "learned" },
    });
    expect(chainHead(ctx, "planner")?.model).toBe("c");
  });

  it("names the configured ordering for a role without a learned entry", async () => {
    const { ctx, events } = run("company-xray");
    await callModel(ctx, { role: "fast", request });
    expect(events[0]).toMatchObject({
      type: "usage.updated",
      payload: { model: "a", role: "fast", ordering: "configured" },
    });
  });

  it("names the configured ordering when the run has no mission", async () => {
    const { ctx, events } = run(undefined);
    await callModel(ctx, { role: "planner", request });
    expect(events[0]).toMatchObject({
      type: "usage.updated",
      payload: { model: "a", ordering: "configured" },
    });
  });
});
