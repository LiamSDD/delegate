import { describe, expect, it } from "vitest";
import { z } from "zod";

import { type ModelFallbackPayload } from "./events";
import { type ModelsConfig, parseModelsConfig, type ChainEntry } from "./models";
import {
  ProviderHttpError,
  ProviderNetworkError,
  ProviderTimeoutError,
  RateLimitedError,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
} from "./providers/types";
import {
  ModelRouter,
  NoModelAvailableError,
  estimatePromptTokens,
  type RouterRequest,
} from "./router";

const config = parseModelsConfig({
  version: 1,
  providers: [
    {
      id: "a",
      kind: "openai-compatible",
      baseUrl: "https://a.test/v1",
      keyless: true,
      terms: "public-demo-ok",
      maxClassification: "public",
      dataPolicy: "x",
      limits: { requestsPerMinute: 2 },
    },
    {
      id: "b",
      kind: "openai-compatible",
      baseUrl: "https://b.test/v1",
      keyless: true,
      terms: "public-demo-ok",
      maxClassification: "internal",
      dataPolicy: "x",
      limits: { tokensPerMinute: 9000 },
    },
    {
      id: "c",
      kind: "openai-compatible",
      baseUrl: "https://c.test/v1",
      keyless: true,
      terms: "public-demo-ok",
      maxClassification: "internal",
      dataPolicy: "x",
    },
  ],
  roles: {
    planner: [
      {
        provider: "a",
        model: "a-1",
        contextWindow: 8000,
        supportsTools: true,
        quirks: ["q-a"],
        reasoningEffort: "low",
      },
      { provider: "b", model: "b-1", contextWindow: 32000, supportsTools: false },
      { provider: "c", model: "c-1", contextWindow: 128000, supportsTools: true },
    ],
    worker: [],
    fast: [],
  },
});

type Behaviour =
  "ok" | Error | "fail-mid-stream" | "error-stop" | "error-stop-mid-stream" | "with-usage";

class FakeProvider implements ModelProvider {
  readonly calls: ModelRequest[] = [];
  behaviours: Behaviour[] = [];
  released = 0;
  constructor(readonly id: string) {}

  async *stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
    this.calls.push(request);
    const behaviour = this.behaviours.shift() ?? "ok";
    try {
      await Promise.resolve();
      if (behaviour instanceof Error) throw behaviour;
      if (behaviour === "error-stop") {
        yield { type: "stop", reason: "error", raw: "provider_error" };
        return;
      }
      yield { type: "text_delta", text: `from ${this.id}` };
      if (behaviour === "fail-mid-stream")
        throw new ProviderNetworkError(this.id, "connection reset");
      if (behaviour === "error-stop-mid-stream") {
        yield { type: "stop", reason: "error", raw: "provider_error" };
        return;
      }
      if (behaviour === "with-usage") {
        yield {
          type: "usage",
          usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      }
      yield { type: "stop", reason: "end" };
    } finally {
      this.released += 1;
    }
  }
}

function setup(routerConfig: ModelsConfig = config) {
  let now = 1_000_000;
  const providers = {
    a: new FakeProvider("a"),
    b: new FakeProvider("b"),
    c: new FakeProvider("c"),
  };
  const fallbacks: ModelFallbackPayload[] = [];
  const router = new ModelRouter({
    env: {},
    context: {
      config: routerConfig,
      audience: "public-demo",
      environment: "server",
      classification: "public",
    },
    createProvider: (entry: ChainEntry) => providers[entry.provider.id as keyof typeof providers],
    emitFallback: (payload) => fallbacks.push(payload),
    now: () => now,
    failureThreshold: 2,
    cooldownMs: 60_000,
  });
  return {
    router,
    providers,
    fallbacks,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const request: RouterRequest = {
  system: "s",
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 1000,
};

async function drain(events: AsyncIterable<ModelStreamEvent>): Promise<string> {
  let text = "";
  for await (const event of events) if (event.type === "text_delta") text += event.text;
  return text;
}

describe("estimatePromptTokens", () => {
  it("uses ceil(characters / 4) over system, messages and tool schemas", () => {
    expect(
      estimatePromptTokens({
        system: "abcd",
        messages: [{ role: "user", content: "abcdefgh" }],
        maxTokens: 1,
      }),
    ).toBe(3);
    const withTool = estimatePromptTokens({
      ...request,
      tools: [{ name: "t", description: "d", inputSchema: z.object({ q: z.string() }) }],
    });
    expect(withTool).toBeGreaterThan(estimatePromptTokens(request));
  });
});

describe("ModelRouter", () => {
  it("serves from the first healthy entry and passes model and quirks", async () => {
    const { router, providers, fallbacks } = setup();
    const routed = await router.open("planner", request);
    expect(routed).toMatchObject({ provider: "a", model: "a-1" });
    expect(await drain(routed.events)).toBe("from a");
    expect(providers.a.calls[0]).toMatchObject({
      model: "a-1",
      quirks: ["q-a"],
      reasoningEffort: "low",
    });
    expect(fallbacks).toEqual([]);
  });

  it("passes a JSON-object request only to entries that carry the json-object quirk", async () => {
    const json = parseModelsConfig({
      ...config,
      roles: {
        ...config.roles,
        planner: [
          { provider: "a", model: "a-1", contextWindow: 8000, supportsTools: true },
          {
            provider: "c",
            model: "c-1",
            contextWindow: 128000,
            supportsTools: true,
            quirks: ["json-object"],
          },
        ],
      },
    });
    const { router, providers } = setup(json);
    const asked = { ...request, responseFormat: { type: "json_object" as const } };
    await router.open("planner", asked);
    providers.a.behaviours = [new ProviderHttpError("a", 503, "down")];
    await router.open("planner", asked);
    expect(providers.a.calls.map((call) => call.responseFormat)).toEqual([undefined, undefined]);
    expect(providers.c.calls[0]?.responseFormat).toEqual({ type: "json_object" });
  });

  it("clamps maxTokens to the entry's output cap", async () => {
    const capped = parseModelsConfig({
      ...config,
      roles: {
        ...config.roles,
        worker: [
          {
            provider: "c",
            model: "c-1",
            contextWindow: 128000,
            supportsTools: true,
            maxOutputTokens: 1500,
          },
        ],
      },
    });
    const { router, providers } = setup(capped);
    const routed = await router.open("worker", { ...request, maxTokens: 6000 });
    await drain(routed.events);
    expect(providers.c.calls[0]?.maxTokens).toBe(1500);
  });

  it("falls back on 429 and honours retry-after before trying the provider again", async () => {
    const { router, providers, fallbacks, advance } = setup();
    providers.a.behaviours = [new RateLimitedError("a", 5000)];
    const routed = await router.open("planner", request);
    expect(routed.provider).toBe("b");
    expect(fallbacks).toEqual([
      {
        role: "planner",
        from: { provider: "a", model: "a-1" },
        to: { provider: "b", model: "b-1" },
        reason: "rate_limited",
        retryAfterMs: 5000,
        ordering: "configured",
      },
    ]);

    advance(1000);
    expect((await router.open("planner", request)).provider).toBe("b");
    expect(providers.a.calls).toHaveLength(1);
    expect(fallbacks[1]).toMatchObject({ reason: "rate_limited", retryAfterMs: 4000 });

    advance(5000);
    expect((await router.open("planner", request)).provider).toBe("a");
  });

  it.each([
    ["server_error", new ProviderHttpError("a", 503, "unavailable")],
    ["timeout", new ProviderTimeoutError("a", 100)],
    ["network_error", new ProviderNetworkError("a", "ECONNRESET")],
  ] as const)("falls back with reason %s", async (reason, error) => {
    const { router, providers, fallbacks } = setup();
    providers.a.behaviours = [error];
    expect((await router.open("planner", request)).provider).toBe("b");
    expect(fallbacks[0]?.reason).toBe(reason);
  });

  it("does not fall back on a plain 400, which signals a bug in the request", async () => {
    const { router, providers, fallbacks } = setup();
    providers.a.behaviours = [new ProviderHttpError("a", 400, "bad request")];
    await expect(router.open("planner", request)).rejects.toBeInstanceOf(ProviderHttpError);
    expect(providers.b.calls).toHaveLength(0);
    expect(fallbacks).toEqual([]);
  });

  it.each([
    [401, "", "client_error"],
    [402, "", "client_error"],
    [403, "", "client_error"],
    [404, "model not found", "model_unavailable"],
    [410, "model retired", "model_unavailable"],
    [408, "", "client_error"],
    [413, "", "context_too_small"],
    [422, "", "client_error"],
    [400, "This model's maximum context length is 8192 tokens", "context_too_small"],
    [400, "max_tokens is too large", "context_too_small"],
  ] as const)(
    "falls back on HTTP %i without counting it against health",
    async (status, body, reason) => {
      const { router, providers, fallbacks } = setup();
      providers.a.behaviours = [
        new ProviderHttpError("a", status, body),
        new ProviderHttpError("a", status, body),
      ];
      expect((await router.open("planner", request)).provider).toBe("b");
      expect((await router.open("planner", request)).provider).toBe("b");
      expect(fallbacks.map((fallback) => fallback.reason)).toEqual([reason, reason]);
      expect(router.health("a")).toMatchObject({ healthy: true, consecutiveFailures: 0 });
    },
  );

  it("treats an in-band error as the first event as a server error and falls back", async () => {
    const { router, providers, fallbacks } = setup();
    providers.a.behaviours = ["error-stop", "error-stop"];
    const routed = await router.open("planner", request);
    expect(routed.provider).toBe("b");
    expect(await drain(routed.events)).toBe("from b");
    expect(fallbacks[0]).toMatchObject({ from: { provider: "a" }, reason: "server_error" });
    expect(providers.a.released).toBe(1);
    expect(router.health("a").consecutiveFailures).toBe(1);
    await router.open("planner", request);
    expect(router.health("a")).toMatchObject({ healthy: false });
  });

  it("counts an in-band error after the first event against provider health", async () => {
    const { router, providers } = setup();
    providers.a.behaviours = ["error-stop-mid-stream"];
    const routed = await router.open("planner", request);
    const events: ModelStreamEvent[] = [];
    for await (const event of routed.events) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: "stop", reason: "error" });
    expect(router.health("a").consecutiveFailures).toBe(1);
  });

  it("releases the provider stream when the caller abandons it before reading", async () => {
    const { router, providers } = setup();
    const routed = await router.open("planner", request);
    const iterator = routed.events[Symbol.asyncIterator]();
    await iterator.return?.();
    expect(providers.a.released).toBe(1);
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });

  it("releases the provider stream when the caller stops part way", async () => {
    const { router, providers } = setup();
    const routed = await router.open("planner", request);
    for await (const event of routed.events) if (event.type === "text_delta") break;
    expect(providers.a.released).toBe(1);
  });

  it("estimates and flags usage when the provider reports none", async () => {
    const { router } = setup();
    const routed = await router.open("planner", request, { estimatedPromptTokens: 40 });
    const events: ModelStreamEvent[] = [];
    for await (const event of routed.events) events.push(event);
    expect(events.slice(-2)).toEqual([
      {
        type: "usage",
        estimated: true,
        usage: {
          inputTokens: 40,
          outputTokens: Math.ceil("from a".length / 4),
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
      { type: "stop", reason: "end" },
    ]);
  });

  it("passes provider usage through without estimating", async () => {
    const { router, providers } = setup();
    providers.a.behaviours = ["with-usage"];
    const routed = await router.open("planner", request);
    const usage: ModelStreamEvent[] = [];
    for await (const event of routed.events) if (event.type === "usage") usage.push(event);
    expect(usage).toEqual([
      {
        type: "usage",
        usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ]);
  });

  it("reports a provider blocked by retry-after as not healthy", async () => {
    const { router, providers, advance } = setup();
    providers.a.behaviours = [new RateLimitedError("a", 5000)];
    await router.open("planner", request);
    expect(router.health("a")).toMatchObject({ healthy: false, blocked: true });
    advance(5000);
    expect(router.health("a")).toMatchObject({ healthy: true, blocked: false });
  });

  it("filters the chain by the classification of each call", async () => {
    const { router, providers } = setup();
    const routed = await router.open("planner", request, { classification: "internal" });
    expect(routed.provider).toBe("b");
    expect(providers.a.calls).toHaveLength(0);
  });

  it("skips entries whose context window is too small for prompt plus output", async () => {
    const { router, providers, fallbacks } = setup();
    const routed = await router.open("planner", request, { estimatedPromptTokens: 7500 });
    expect(routed.provider).toBe("b");
    expect(providers.a.calls).toHaveLength(0);
    expect(fallbacks[0]).toMatchObject({ reason: "context_too_small", from: { provider: "a" } });
  });

  it("skips entries without tool support when tools are requested", async () => {
    const { router, fallbacks } = setup();
    const withTools: RouterRequest = {
      ...request,
      tools: [
        { name: "web_fetch", description: "Fetch", inputSchema: z.object({ url: z.string() }) },
      ],
    };
    const routed = await router.open("planner", withTools, { estimatedPromptTokens: 7500 });
    expect(routed.provider).toBe("c");
    expect(fallbacks.map((fallback) => fallback.reason)).toEqual([
      "context_too_small",
      "tools_unsupported",
    ]);
  });

  it("applies request-per-minute buckets and refills them over time", async () => {
    const { router, fallbacks, advance } = setup();
    expect((await router.open("planner", request)).provider).toBe("a");
    expect((await router.open("planner", request)).provider).toBe("a");
    expect((await router.open("planner", request)).provider).toBe("b");
    expect(fallbacks[0]).toMatchObject({ reason: "rate_limited", retryAfterMs: 30000 });
    advance(30_000);
    expect((await router.open("planner", request)).provider).toBe("a");
  });

  it("applies token-per-minute buckets using prompt plus max output", async () => {
    const { router, providers } = setup();
    providers.a.behaviours = [new RateLimitedError("a", 120_000)];
    for (let call = 0; call < 3; call += 1) {
      expect(
        (await router.open("planner", request, { estimatedPromptTokens: 2000 })).provider,
      ).toBe("b");
    }
    expect((await router.open("planner", request, { estimatedPromptTokens: 2000 })).provider).toBe(
      "c",
    );
  });

  it("skips a provider whose per-minute token bucket can never fit the request", async () => {
    const { router, providers, fallbacks } = setup();
    providers.a.behaviours = [new RateLimitedError("a", 120_000)];
    expect((await router.open("planner", request, { estimatedPromptTokens: 8500 })).provider).toBe(
      "c",
    );
    expect(providers.b.calls).toHaveLength(0);
    expect(fallbacks[1]).toEqual({
      role: "planner",
      from: { provider: "b", model: "b-1" },
      to: { provider: "c", model: "c-1" },
      reason: "exceeds_provider_capacity",
      ordering: "configured",
    });
  });

  it("marks a provider unhealthy after consecutive failures until the cooldown passes", async () => {
    const { router, providers, fallbacks, advance } = setup();
    providers.a.behaviours = [
      new ProviderHttpError("a", 500, ""),
      new ProviderHttpError("a", 500, ""),
    ];
    await router.open("planner", request);
    advance(31_000);
    await router.open("planner", request);
    advance(31_000);
    expect((await router.open("planner", request)).provider).toBe("b");
    expect(providers.a.calls).toHaveLength(2);
    expect(fallbacks.at(-1)?.reason).toBe("unhealthy");
    expect(router.health("a")).toMatchObject({ healthy: false });

    advance(60_000);
    expect((await router.open("planner", request)).provider).toBe("a");
    expect(router.health("a")).toMatchObject({ healthy: true, consecutiveFailures: 0 });
  });

  it("counts mid-stream failures against provider health and rethrows", async () => {
    const { router, providers } = setup();
    providers.a.behaviours = ["fail-mid-stream"];
    const routed = await router.open("planner", request);
    await expect(drain(routed.events)).rejects.toBeInstanceOf(ProviderNetworkError);
    expect(router.health("a").consecutiveFailures).toBe(1);
  });

  it("throws NoModelAvailableError after the chain is exhausted and emits a final fallback to null", async () => {
    const { router, providers, fallbacks } = setup();
    providers.a.behaviours = [new RateLimitedError("a")];
    providers.b.behaviours = [new ProviderTimeoutError("b", 10)];
    providers.c.behaviours = [new ProviderHttpError("c", 502, "")];
    const error = await router.open("planner", request).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NoModelAvailableError);
    expect((error as NoModelAvailableError).attempts.map((attempt) => attempt.reason)).toEqual([
      "rate_limited",
      "timeout",
      "server_error",
    ]);
    expect(fallbacks.at(-1)).toMatchObject({ from: { provider: "c" }, to: null });
  });

  it("throws NoModelAvailableError when no provider is available for the role", async () => {
    const { router } = setup();
    await expect(router.open("worker", request)).rejects.toBeInstanceOf(NoModelAvailableError);
  });
});
