import { describe, expect, it } from "vitest";
import { z } from "zod";

import { type ModelFallbackPayload } from "./events";
import { parseModelsConfig, type ChainEntry } from "./models";
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
      dataPolicy: "x",
      limits: { requestsPerMinute: 2 },
    },
    {
      id: "b",
      kind: "openai-compatible",
      baseUrl: "https://b.test/v1",
      keyless: true,
      terms: "public-demo-ok",
      dataPolicy: "x",
      limits: { tokensPerMinute: 9000 },
    },
    {
      id: "c",
      kind: "openai-compatible",
      baseUrl: "https://c.test/v1",
      keyless: true,
      terms: "public-demo-ok",
      dataPolicy: "x",
    },
  ],
  roles: {
    planner: [
      { provider: "a", model: "a-1", contextWindow: 8000, supportsTools: true, quirks: ["q-a"] },
      { provider: "b", model: "b-1", contextWindow: 32000, supportsTools: false },
      { provider: "c", model: "c-1", contextWindow: 128000, supportsTools: true },
    ],
    worker: [],
    fast: [],
  },
});

type Behaviour = "ok" | Error | "fail-mid-stream";

class FakeProvider implements ModelProvider {
  readonly calls: ModelRequest[] = [];
  behaviours: Behaviour[] = [];
  constructor(readonly id: string) {}

  async *stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
    this.calls.push(request);
    const behaviour = this.behaviours.shift() ?? "ok";
    await Promise.resolve();
    if (behaviour instanceof Error) throw behaviour;
    yield { type: "text_delta", text: `from ${this.id}` };
    if (behaviour === "fail-mid-stream")
      throw new ProviderNetworkError(this.id, "connection reset");
    yield { type: "stop", reason: "end" };
  }
}

function setup() {
  let now = 1_000_000;
  const providers = {
    a: new FakeProvider("a"),
    b: new FakeProvider("b"),
    c: new FakeProvider("c"),
  };
  const fallbacks: ModelFallbackPayload[] = [];
  const router = new ModelRouter({
    env: {},
    context: { config, audience: "public-demo", environment: "server" },
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
    expect(providers.a.calls[0]).toMatchObject({ model: "a-1", quirks: ["q-a"] });
    expect(fallbacks).toEqual([]);
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

  it("does not fall back on client errors", async () => {
    const { router, providers, fallbacks } = setup();
    providers.a.behaviours = [new ProviderHttpError("a", 400, "bad request")];
    await expect(router.open("planner", request)).rejects.toBeInstanceOf(ProviderHttpError);
    expect(providers.b.calls).toHaveLength(0);
    expect(fallbacks).toEqual([]);
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
      reason: "rate_limited",
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
