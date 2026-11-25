import { afterEach, describe, expect, it } from "vitest";

import { type ModelFallbackPayload } from "./events";
import { parseModelsConfig, type ChainEntry } from "./models";
import {
  ProviderHttpError,
  RateLimitedError,
  type ModelProvider,
  type ModelStreamEvent,
} from "./providers/types";
import { ModelRouter, resetProcessRouterState, type RouterRequest } from "./router";

function configWith(scope: "run" | "process") {
  return parseModelsConfig({
    version: 1,
    providers: [
      {
        id: "nv",
        kind: "openai-compatible",
        baseUrl: "https://nv.test/v1",
        keyless: true,
        terms: "public-demo-ok",
        maxClassification: "public",
        dataPolicy: "x",
        limits: { modelRequestsPerMinute: 1, scope },
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
        { provider: "nv", model: "first", contextWindow: 8000, supportsTools: true },
        { provider: "nv", model: "second", contextWindow: 8000, supportsTools: true },
        { provider: "nv", model: "third", contextWindow: 8000, supportsTools: true },
        { provider: "free", model: "keyless", contextWindow: 8000, supportsTools: true },
      ],
      worker: [{ provider: "free", model: "keyless", contextWindow: 8000, supportsTools: true }],
      fast: [{ provider: "free", model: "keyless", contextWindow: 8000, supportsTools: true }],
    },
  });
}

const request: RouterRequest = {
  system: "s",
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 50,
};

const answer: ModelStreamEvent[] = [
  { type: "text_delta", text: "ok" },
  { type: "stop", reason: "end" },
];

function setup(
  options: {
    scope?: "run" | "process";
    failures?: Map<string, () => Error>;
    clock?: { now: number };
  } = {},
) {
  const clock = options.clock ?? { now: 0 };
  const fallbacks: ModelFallbackPayload[] = [];
  const served: string[] = [];
  const provider = (id: string): ModelProvider => ({
    id,
    async *stream(req) {
      await Promise.resolve();
      const failure = options.failures?.get(req.model);
      if (failure !== undefined) throw failure();
      yield* answer;
    },
  });
  const providers = { nv: provider("nv"), free: provider("free") };
  const router = new ModelRouter({
    env: {},
    context: {
      config: configWith(options.scope ?? "run"),
      audience: "public-demo",
      environment: "server",
      classification: "public",
    },
    createProvider: (entry: ChainEntry) => providers[entry.provider.id as keyof typeof providers],
    emitFallback: (payload) => fallbacks.push(payload),
    now: () => clock.now,
  });
  const next = async () => {
    const routed = await router.open("planner", request);
    for await (const event of routed.events) if (event.type === "stop") break;
    served.push(routed.model);
    return routed.model;
  };
  return { router, clock, fallbacks, served, next };
}

afterEach(() => {
  resetProcessRouterState();
});

describe("priority rotation with automatic return", () => {
  it("uses the primary while it is available", async () => {
    const { next, fallbacks } = setup();
    expect(await next()).toBe("first");
    expect(fallbacks).toEqual([]);
  });

  it("moves down the ranking as per-model buckets empty, then to keyless", async () => {
    const { next, fallbacks } = setup();
    expect(await next()).toBe("first");
    expect(await next()).toBe("second");
    expect(await next()).toBe("third");
    expect(await next()).toBe("keyless");
    expect(fallbacks.map((entry) => [entry.from.model, entry.reason])).toContainEqual([
      "first",
      "rate_limited",
    ]);
  });

  it("returns to the primary as soon as its bucket refills (no sticky downgrade)", async () => {
    const { next, clock } = setup();
    await next();
    expect(await next()).toBe("second");
    clock.now += 60_000;
    expect(await next()).toBe("first");
    expect(await next()).toBe("second");
  });

  it("learns from a 429 retry-after and comes back when it elapses", async () => {
    let throttled = true;
    const failures = new Map<string, () => Error>([
      ["first", () => (throttled ? new RateLimitedError("nv", 5_000) : new Error("unreachable"))],
    ]);
    const { next, clock, fallbacks } = setup({ failures });
    expect(await next()).toBe("second");
    expect(fallbacks[0]).toMatchObject({ from: { model: "first" }, reason: "rate_limited" });
    failures.delete("first");
    throttled = false;
    clock.now += 60_000;
    expect(await next()).toBe("first");
  });

  it("treats a 429 without retry-after as an empty bucket for that model only", async () => {
    const failures = new Map<string, () => Error>([["first", () => new RateLimitedError("nv")]]);
    const { next, clock } = setup({ failures });
    expect(await next()).toBe("second");
    failures.delete("first");
    clock.now += 30_000;
    expect(await next()).toBe("third");
    clock.now += 30_000;
    expect(await next()).toBe("first");
  });

  it("skips an erroring model for one call and retries it on the next", async () => {
    const failures = new Map<string, () => Error>([
      ["first", () => new ProviderHttpError("nv", 503, "busy")],
    ]);
    const { next, clock } = setup({ failures });
    expect(await next()).toBe("second");
    failures.delete("first");
    clock.now += 60_000;
    expect(await next()).toBe("first");
  });

  it("shares process-scoped buckets across routers (concurrent visitors)", async () => {
    const clock = { now: 0 };
    const visitorA = setup({ scope: "process", clock });
    const visitorB = setup({ scope: "process", clock });
    expect(await visitorA.next()).toBe("first");
    expect(await visitorB.next()).toBe("second");
    expect(await visitorA.next()).toBe("third");
    expect(await visitorB.next()).toBe("keyless");
  });
});
