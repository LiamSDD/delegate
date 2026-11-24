import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createOpenAICompatibleProvider } from "./openai-compatible";
import { parseSse } from "./sse";
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

describe("OpenAI-compatible adapter", () => {
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
      raw: "upstream overloaded",
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
