import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { parseModelsConfig, type ChainEntry } from "../models";
import { ModelRouter } from "../router";
import { createOpenAICompatibleProvider } from "./openai-compatible";
import { SseLimitError, SseLineSplitter, SseTimeoutError, parseSse } from "./sse";
import {
  ProviderHttpError,
  ProviderNetworkError,
  ProviderTimeoutError,
  RateLimitedError,
  type ModelRequest,
  type ModelStreamEvent,
} from "./types";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

function chunked(text: string, size: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

interface Captured {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function fakeFetch(response: () => Response, captured: Captured[] = []): typeof fetch {
  return (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    captured.push({ url, headers: new Headers(init?.headers), body });
    return Promise.resolve(response());
  };
}

function never(onCancel?: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream({
    pull: () => new Promise<void>(() => undefined),
    cancel: () => {
      onCancel?.();
    },
  });
}

function trickle(chunk: string, everyMs: number, count = Number.POSITIVE_INFINITY) {
  const bytes = new TextEncoder().encode(chunk);
  let sent = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new ReadableStream<Uint8Array>({
    pull: (controller) =>
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          if (sent >= count) controller.close();
          else controller.enqueue(bytes);
          sent += 1;
          resolve();
        }, everyMs);
      }),
    cancel: () => {
      clearTimeout(timer);
    },
  });
}

async function messagesOf(body: ReadableStream<Uint8Array>, options = {}) {
  const out = [];
  for await (const message of parseSse(body, options)) out.push(message);
  return out;
}

function sseResponse(text: string, size = 7): Response {
  return new Response(chunked(text, size), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function collect(events: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const out: ModelStreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

const request: ModelRequest = {
  model: "gpt-oss-120b",
  system: "You are a researcher.",
  messages: [{ role: "user", content: "Profile example.com" }],
  maxTokens: 512,
};

describe("parseSse", () => {
  it("handles comments, CRLF, multi-line data and split chunks", async () => {
    const raw = ": ping\r\nevent: message\r\ndata: one\r\ndata: two\r\n\r\ndata: three\n\n";
    const messages = [];
    for await (const message of parseSse(chunked(raw, 3))) messages.push(message);
    expect(messages).toEqual([
      { event: "message", data: "one\ntwo" },
      { event: undefined, data: "three" },
    ]);
  });
});

describe("parseSse limits and timeouts", () => {
  it("splits CR, LF and CRLF across chunk boundaries", async () => {
    expect(await messagesOf(chunked("data: a\r\r\ndata: b\r\n\r\ndata: c\n\n", 1))).toEqual([
      { event: undefined, data: "a" },
      { event: undefined, data: "b" },
      { event: undefined, data: "c" },
    ]);
  });

  it("scans each appended character once, however the line is chunked", () => {
    const splitter = new SseLineSplitter();
    const piece = "x".repeat(256);
    for (let index = 0; index < 3600; index += 1) expect(splitter.push(piece)).toEqual([]);
    const [line] = splitter.push("\n");
    expect(line).toHaveLength(256 * 3600);
    expect(splitter.scannedChars).toBe(256 * 3600 + 1);
  });

  it("caps line, event and body size", async () => {
    await expect(
      messagesOf(chunked(`data: ${"x".repeat(2000)}\n\n`, 64), { maxLineChars: 1000 }),
    ).rejects.toMatchObject({ limit: "line" });
    await expect(
      messagesOf(chunked(`data: ${"x".repeat(600)}\ndata: ${"y".repeat(600)}\n\n`, 64), {
        maxEventChars: 1000,
      }),
    ).rejects.toMatchObject({ limit: "event" });
    await expect(
      messagesOf(chunked("data: 1\n\n".repeat(500), 64), { maxBodyBytes: 1000 }),
    ).rejects.toBeInstanceOf(SseLimitError);
  });

  it("times out when no chunk arrives within the idle timeout and cancels the body", async () => {
    let cancelled = false;
    const error = await messagesOf(
      never(() => {
        cancelled = true;
      }),
      { idleTimeoutMs: 20 },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SseTimeoutError);
    expect(error).toMatchObject({ kind: "idle", timeoutMs: 20 });
    expect(cancelled).toBe(true);
  });

  it("resets the idle timeout on every chunk but enforces a total duration", async () => {
    expect(await messagesOf(trickle("data: x\n\n", 15, 6), { idleTimeoutMs: 60 })).toHaveLength(6);
    await expect(
      messagesOf(trickle("data: x\n\n", 10), { idleTimeoutMs: 60, totalTimeoutMs: 80 }),
    ).rejects.toMatchObject({ kind: "total" });
  });
});

describe("OpenAI-compatible adapter", () => {
  it("throws ProviderTimeoutError when the body stalls before any event", async () => {
    const provider = createOpenAICompatibleProvider({
      id: "p",
      baseUrl: "https://p.test/v1",
      idleTimeoutMs: 20,
      fetch: fakeFetch(() => new Response(never(), { status: 200 })),
    });
    const error = await collect(provider.stream(request)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderTimeoutError);
    expect(error).toMatchObject({ providerId: "p", timeoutMs: 20 });
  });

  it("enforces a total duration on slow but steady bodies", async () => {
    const provider = createOpenAICompatibleProvider({
      id: "p",
      baseUrl: "https://p.test/v1",
      idleTimeoutMs: 60,
      totalTimeoutMs: 80,
      fetch: fakeFetch(
        () =>
          new Response(trickle('data: {"choices":[{"index":0,"delta":{"content":"x"}}]}\n\n', 10), {
            status: 200,
          }),
      ),
    });
    await expect(collect(provider.stream(request))).rejects.toMatchObject({
      name: "ProviderTimeoutError",
      timeoutMs: 80,
    });
  });

  it("lets the router fall back when a provider stalls before the first event", async () => {
    const config = parseModelsConfig({
      version: 1,
      providers: ["slow", "fast"].map((id) => ({
        id,
        kind: "openai-compatible",
        baseUrl: `https://${id}.test/v1`,
        keyless: true,
        terms: "public-demo-ok",
        maxClassification: "public",
        dataPolicy: "x",
      })),
      roles: {
        planner: [
          { provider: "slow", model: "m", contextWindow: 32000, supportsTools: true },
          { provider: "fast", model: "m", contextWindow: 32000, supportsTools: true },
        ],
        worker: [],
        fast: [],
      },
    });
    const reasons: string[] = [];
    const router = new ModelRouter({
      env: {},
      context: { config, audience: "public-demo", environment: "server", classification: "public" },
      createProvider: (entry: ChainEntry) =>
        createOpenAICompatibleProvider({
          id: entry.provider.id,
          baseUrl: entry.provider.baseUrl ?? "",
          idleTimeoutMs: 20,
          fetch: fakeFetch(() =>
            entry.provider.id === "slow"
              ? new Response(never(), { status: 200 })
              : sseResponse(fixture("text.sse")),
          ),
        }),
      emitFallback: (payload) => reasons.push(payload.reason),
    });
    const routed = await router.open("planner", request);
    expect(routed.provider).toBe("fast");
    expect(reasons).toEqual(["timeout"]);
  });

  it("stops with error instead of buffering an oversized response", async () => {
    const provider = createOpenAICompatibleProvider({
      id: "p",
      baseUrl: "https://p.test/v1",
      maxBodyBytes: 512,
      fetch: fakeFetch(() => sseResponse(fixture("text.sse"), 64)),
    });
    expect((await collect(provider.stream(request))).at(-1)).toEqual({
      type: "stop",
      reason: "error",
      raw: "response exceeded size limit",
    });
  });

  it("reads only a bounded prefix of error bodies and keeps them out of the message", async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1024;
        controller.enqueue(new TextEncoder().encode("secret-body ".repeat(85)));
      },
    });
    const provider = createOpenAICompatibleProvider({
      id: "p",
      baseUrl: "https://p.test/v1",
      fetch: fakeFetch(() => new Response(endless, { status: 503 })),
    });
    const error = await collect(provider.stream(request)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect(pulled).toBeLessThanOrEqual(8 * 1024);
    expect((error as ProviderHttpError).bodySnippet.length).toBeLessThanOrEqual(300);
    expect((error as Error).message).toBe("p: HTTP 503");
  });

  it("does not hang on an error body that never arrives", async () => {
    const provider = createOpenAICompatibleProvider({
      id: "p",
      baseUrl: "https://p.test/v1",
      idleTimeoutMs: 20,
      fetch: fakeFetch(() => new Response(never(), { status: 502 })),
    });
    await expect(collect(provider.stream(request))).rejects.toMatchObject({ status: 502 });
  });

  it("refuses redirects", async () => {
    const inits: RequestInit[] = [];
    const provider = createOpenAICompatibleProvider({
      id: "p",
      baseUrl: "https://p.test/v1",
      fetch: (_input, init) => {
        if (init !== undefined) inits.push(init);
        return Promise.resolve(sseResponse(fixture("text.sse")));
      },
    });
    await collect(provider.stream(request));
    expect(inits[0]?.redirect).toBe("error");
  });

  it("does not double-append tool names that the provider resends in full", async () => {
    const provider = createOpenAICompatibleProvider({
      id: "p",
      baseUrl: "https://p.test/v1",
      fetch: fakeFetch(() => sseResponse(fixture("tool-calls-repeated-name.sse"), 13)),
    });
    const events = await collect(provider.stream(request));
    expect(events.filter((event) => event.type === "tool_call_complete")).toEqual([
      {
        type: "tool_call_complete",
        call: { id: "call_a", name: "web_fetch", argumentsJson: '{"url":"https://example.com"}' },
      },
      {
        type: "tool_call_complete",
        call: { id: "call_b", name: "web_fetch", argumentsJson: "{}" },
      },
    ]);
    const names = events
      .filter((event) => event.type === "tool_call_delta" && event.index === 0)
      .map((event) => (event.type === "tool_call_delta" ? (event.name ?? "") : ""))
      .join("");
    expect(names).toBe("web_fetch");
  });

  it("streams text and normalises usage with cached tokens", async () => {
    const captured: Captured[] = [];
    const provider = createOpenAICompatibleProvider({
      id: "llm7",
      baseUrl: "https://api.llm7.test/v1",
      fetch: fakeFetch(() => sseResponse(fixture("text.sse")), captured),
    });
    const events = await collect(provider.stream(request));

    expect(
      events
        .filter((event) => event.type === "text_delta")
        .map((event) => event.text)
        .join(""),
    ).toBe("Hello, world");
    expect(events.at(-2)).toEqual({
      type: "usage",
      usage: { inputTokens: 20, outputTokens: 9, cacheReadTokens: 100, cacheWriteTokens: 0 },
    });
    expect(events.at(-1)).toEqual({ type: "stop", reason: "end", raw: "stop" });

    const [call] = captured;
    expect(call?.url).toBe("https://api.llm7.test/v1/chat/completions");
    expect(call?.headers.has("authorization")).toBe(false);
    expect(call?.body).toMatchObject({
      model: "gpt-oss-120b",
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 512,
      messages: [
        { role: "system", content: "You are a researcher." },
        { role: "user", content: "Profile example.com" },
      ],
    });
  });

  it("sends reasoning_effort only when the chain entry sets it", async () => {
    const captured: Captured[] = [];
    const provider = createOpenAICompatibleProvider({
      id: "nvidia",
      baseUrl: "https://nvidia.test/v1",
      fetch: fakeFetch(() => sseResponse(fixture("text.sse")), captured),
    });
    await collect(provider.stream({ ...request, reasoningEffort: "low" }));
    await collect(provider.stream(request));
    expect(captured[0]?.body.reasoning_effort).toBe("low");
    expect("reasoning_effort" in (captured[1]?.body ?? {})).toBe(false);
  });

  it("turns thinking off through chat_template_kwargs for the disable-thinking quirk", async () => {
    const captured: Captured[] = [];
    const provider = createOpenAICompatibleProvider({
      id: "nvidia",
      baseUrl: "https://nvidia.test/v1",
      fetch: fakeFetch(() => sseResponse(fixture("text.sse")), captured),
    });
    await collect(provider.stream({ ...request, quirks: ["disable-thinking"] }));
    await collect(provider.stream(request));
    expect(captured[0]?.body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect("chat_template_kwargs" in (captured[1]?.body ?? {})).toBe(false);
  });

  it("assembles multiple interleaved tool calls and reasoning", async () => {
    const provider = createOpenAICompatibleProvider({
      id: "nvidia",
      baseUrl: "https://nvidia.test/v1",
      apiKey: "secret",
      fetch: fakeFetch(() => sseResponse(fixture("tool-calls.sse"), 11)),
    });
    const events = await collect(provider.stream(request));

    expect(
      events
        .filter((event) => event.type === "reasoning_delta")
        .map((event) => event.text)
        .join(""),
    ).toBe("Need the sitemap and the about page.");
    expect(events.filter((event) => event.type === "tool_call_delta")).toHaveLength(5);
    expect(events.filter((event) => event.type === "tool_call_complete")).toEqual([
      {
        type: "tool_call_complete",
        call: {
          id: "call_a",
          name: "web_fetch",
          argumentsJson: '{"url":"https://example.com/sitemap.xml"}',
        },
      },
      {
        type: "tool_call_complete",
        call: {
          id: "call_b",
          name: "web_fetch",
          argumentsJson: '{"url":"https://example.com/about"}',
        },
      },
    ]);
    expect(events.at(-2)).toEqual({
      type: "usage",
      usage: { inputTokens: 800, outputTokens: 64, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    expect(events.at(-1)).toEqual({ type: "stop", reason: "tool_use", raw: "tool_calls" });
  });

  it("maps length to max_tokens and a truncated stream to error", async () => {
    const lengthProvider = createOpenAICompatibleProvider({
      id: "p",
      baseUrl: "https://p.test/v1",
      fetch: fakeFetch(() => sseResponse(fixture("length.sse"))),
    });
    expect((await collect(lengthProvider.stream(request))).at(-1)).toEqual({
      type: "stop",
      reason: "max_tokens",
      raw: "length",
    });

    const truncated = createOpenAICompatibleProvider({
      id: "p",
      baseUrl: "https://p.test/v1",
      fetch: fakeFetch(() => sseResponse(fixture("truncated.sse"))),
    });
    expect((await collect(truncated.stream(request))).at(-1)).toMatchObject({
      type: "stop",
      reason: "error",
    });
  });

  it("stops with error when the provider sends an error chunk mid-stream", async () => {
    const provider = createOpenAICompatibleProvider({
      id: "p",
      baseUrl: "https://p.test/v1",
      fetch: fakeFetch(() => sseResponse(fixture("midstream-error.sse"))),
    });
    expect((await collect(provider.stream(request))).at(-1)).toEqual({
      type: "stop",
      reason: "error",
      raw: "provider_error",
    });
  });

  it("throws RateLimitedError with retry-after on 429", async () => {
    const provider = createOpenAICompatibleProvider({
      id: "pollinations",
      baseUrl: "https://p.test",
      chatPath: "/openai",
      fetch: fakeFetch(
        () =>
          new Response('{"error":"Too many requests"}', {
            status: 429,
            headers: { "retry-after": "7" },
          }),
      ),
    });
    const error = await collect(provider.stream(request)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error).toMatchObject({ providerId: "pollinations", retryAfterMs: 7000 });
  });

  it("parses retry-after given as an HTTP date", async () => {
    const now = Date.parse("2026-11-24T10:00:00Z");
    const provider = createOpenAICompatibleProvider({
      id: "p",
      baseUrl: "https://p.test/v1",
      now: () => now,
      fetch: fakeFetch(
        () =>
          new Response("", {
            status: 429,
            headers: { "retry-after": "Tue, 24 Nov 2026 10:00:30 GMT" },
          }),
      ),
    });
    await expect(collect(provider.stream(request))).rejects.toMatchObject({ retryAfterMs: 30000 });
  });

  it("throws ProviderHttpError for 5xx and 4xx without leaking the key", async () => {
    const provider = createOpenAICompatibleProvider({
      id: "groq",
      baseUrl: "https://groq.test/v1",
      apiKey: "gsk_secret",
      fetch: fakeFetch(() => new Response("bad gateway", { status: 502 })),
    });
    const error = await collect(provider.stream(request)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect(error).toMatchObject({ status: 502 });
    expect(String(error)).not.toContain("gsk_secret");
  });

  it("wraps network failures and times out waiting for headers", async () => {
    const offline = createOpenAICompatibleProvider({
      id: "p",
      baseUrl: "https://p.test/v1",
      fetch: () => Promise.reject(new TypeError("fetch failed")),
    });
    await expect(collect(offline.stream(request))).rejects.toBeInstanceOf(ProviderNetworkError);

    const hanging = createOpenAICompatibleProvider({
      id: "p",
      baseUrl: "https://p.test/v1",
      timeoutMs: 10,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    });
    await expect(collect(hanging.stream(request))).rejects.toBeInstanceOf(ProviderTimeoutError);
  });

  it("sends tools as JSON schema, structured output and tool history", async () => {
    const captured: Captured[] = [];
    const provider = createOpenAICompatibleProvider({
      id: "groq",
      baseUrl: "https://groq.test/v1",
      apiKey: "gsk_secret",
      fetch: fakeFetch(() => sseResponse(fixture("text.sse")), captured),
    });
    await collect(
      provider.stream({
        ...request,
        tools: [
          {
            name: "web_fetch",
            description: "Fetch a public URL",
            inputSchema: z.object({ url: z.url() }),
          },
        ],
        responseFormat: {
          type: "json_schema",
          name: "plan",
          schema: z.object({ steps: z.array(z.string()) }),
        },
        messages: [
          { role: "user", content: "Profile example.com" },
          {
            role: "assistant",
            content: "",
            reasoning: "Fetch first.",
            toolCalls: [
              { id: "call_a", name: "web_fetch", argumentsJson: '{"url":"https://example.com"}' },
            ],
          },
          { role: "tool", toolCallId: "call_a", name: "web_fetch", content: "<extraction>" },
        ],
      }),
    );
    const body = captured[0]?.body;
    expect(captured[0]?.headers.get("authorization")).toBe("Bearer gsk_secret");
    expect(body?.tools).toEqual([
      {
        type: "function",
        function: {
          name: "web_fetch",
          description: "Fetch a public URL",
          parameters: {
            type: "object",
            properties: { url: { type: "string", format: "uri" } },
            required: ["url"],
            additionalProperties: false,
          },
        },
      },
    ]);
    expect(body?.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "plan", strict: true },
    });
    expect(body?.messages).toEqual([
      { role: "system", content: "You are a researcher." },
      { role: "user", content: "Profile example.com" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_a",
            type: "function",
            function: { name: "web_fetch", arguments: '{"url":"https://example.com"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_a", content: "<extraction>" },
    ]);
  });

  it("echoes reasoning_content back on assistant turns for the Kimi quirk", async () => {
    const captured: Captured[] = [];
    const provider = createOpenAICompatibleProvider({
      id: "nvidia",
      baseUrl: "https://nvidia.test/v1",
      apiKey: "nv",
      fetch: fakeFetch(() => sseResponse(fixture("text.sse")), captured),
    });
    await collect(
      provider.stream({
        ...request,
        quirks: ["echo-reasoning-content"],
        messages: [
          { role: "user", content: "Go" },
          {
            role: "assistant",
            content: "",
            reasoning: "Fetch first.",
            toolCalls: [{ id: "call_a", name: "web_fetch", argumentsJson: "{}" }],
          },
          { role: "tool", toolCallId: "call_a", name: "web_fetch", content: "ok" },
          { role: "assistant", content: "Done" },
          { role: "user", content: "Next" },
        ],
      }),
    );
    const messages = captured[0]?.body.messages as Record<string, unknown>[];
    expect(messages[2]).toMatchObject({ role: "assistant", reasoning_content: "Fetch first." });
    expect(messages[4]).toMatchObject({
      role: "assistant",
      content: "Done",
      reasoning_content: "",
    });
  });
});
