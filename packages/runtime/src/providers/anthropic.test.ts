import { APIConnectionTimeoutError, InternalServerError, RateLimitError } from "@anthropic-ai/sdk";
import {
  type MessageCreateParamsStreaming,
  type RawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/messages";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createAnthropicProvider } from "./anthropic";
import {
  ProviderHttpError,
  ProviderTimeoutError,
  RateLimitedError,
  type ModelRequest,
  type ModelStreamEvent,
} from "./types";

function events(raw: unknown[]): RawMessageStreamEvent[] {
  return raw as RawMessageStreamEvent[];
}

const messageStart = {
  type: "message_start",
  message: {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: {
      input_tokens: 50,
      output_tokens: 1,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 40,
    },
  },
};

const toolUseStream = events([
  messageStart,
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "thinking", thinking: "", signature: "" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: "Plan the fetch." },
  },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig_1" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Fetching." } },
  { type: "content_block_stop", index: 1 },
  {
    type: "content_block_start",
    index: 2,
    content_block: { type: "tool_use", id: "toolu_1", name: "web_fetch", input: {} },
  },
  {
    type: "content_block_delta",
    index: 2,
    delta: { type: "input_json_delta", partial_json: '{"url":' },
  },
  {
    type: "content_block_delta",
    index: 2,
    delta: { type: "input_json_delta", partial_json: '"https://example.com"}' },
  },
  { type: "content_block_stop", index: 2 },
  {
    type: "message_delta",
    delta: { stop_reason: "tool_use", stop_sequence: null },
    usage: { output_tokens: 75 },
  },
  { type: "message_stop" },
]);

async function* replay(list: RawMessageStreamEvent[]): AsyncGenerator<RawMessageStreamEvent> {
  for (const event of list) {
    await Promise.resolve();
    yield event;
  }
}

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const out: ModelStreamEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

const request: ModelRequest = {
  model: "claude-opus-5-5",
  system: "You are the planner.",
  messages: [{ role: "user", content: "Plan an X-ray of example.com" }],
  maxTokens: 2048,
  tools: [
    {
      name: "web_fetch",
      description: "Fetch a public URL",
      inputSchema: z.object({ url: z.url() }),
    },
  ],
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Anthropic BYOK client", () => {
  it("requires a non-empty visitor key", () => {
    expect(() => createAnthropicProvider({})).toThrow(/key/);
    expect(() => createAnthropicProvider({ apiKey: "   " })).toThrow(/key/);
    expect(() =>
      createAnthropicProvider({ createStream: () => Promise.resolve(replay(toolUseStream)) }),
    ).not.toThrow();
  });

  it("never falls back to server credentials or base URL from the environment", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://env-proxy.invalid");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "server-token");
    vi.stubEnv("ANTHROPIC_API_KEY", "server-key");
    const seen: { url: string; headers: Headers; redirect: RequestInit["redirect"] }[] = [];
    const provider = createAnthropicProvider({
      apiKey: "sk-visitor",
      fetch: (input, init) => {
        seen.push({
          url: input instanceof Request ? input.url : String(input),
          headers: new Headers(init?.headers),
          redirect: init?.redirect,
        });
        return Promise.resolve(
          new Response('{"type":"error","error":{"type":"api_error","message":"x"}}', {
            status: 500,
            headers: { "content-type": "application/json" },
          }),
        );
      },
    });
    await expect(collect(provider.stream(request))).rejects.toBeInstanceOf(ProviderHttpError);
    expect(seen[0]?.url.startsWith("https://api.anthropic.com/")).toBe(true);
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer sk-visitor");
    expect(JSON.stringify([...(seen[0]?.headers.entries() ?? [])])).not.toMatch(/server-/);
    expect(seen[0]?.redirect).toBe("error");
  });
});

describe("Anthropic adapter", () => {
  it("normalises thinking, text, tool use, usage and stop reason", async () => {
    const provider = createAnthropicProvider({
      createStream: () => Promise.resolve(replay(toolUseStream)),
    });
    const out = await collect(provider.stream(request));
    expect(out).toEqual([
      { type: "reasoning_delta", text: "Plan the fetch." },
      { type: "reasoning_signature", signature: "sig_1" },
      { type: "text_delta", text: "Fetching." },
      { type: "tool_call_delta", index: 2, id: "toolu_1", name: "web_fetch", argumentsDelta: "" },
      { type: "tool_call_delta", index: 2, argumentsDelta: '{"url":' },
      { type: "tool_call_delta", index: 2, argumentsDelta: '"https://example.com"}' },
      {
        type: "tool_call_complete",
        call: { id: "toolu_1", name: "web_fetch", argumentsJson: '{"url":"https://example.com"}' },
      },
      {
        type: "usage",
        usage: { inputTokens: 50, outputTokens: 75, cacheReadTokens: 900, cacheWriteTokens: 40 },
      },
      { type: "stop", reason: "tool_use", raw: "tool_use" },
    ]);
  });

  it("maps refusal, max_tokens and pause_turn stop reasons", async () => {
    for (const [raw, reason] of [
      ["refusal", "refusal"],
      ["max_tokens", "max_tokens"],
      ["end_turn", "end"],
      ["pause_turn", "pause_turn"],
      ["some_future_reason", "error"],
    ] as const) {
      const provider = createAnthropicProvider({
        createStream: () =>
          Promise.resolve(
            replay(
              events([
                messageStart,
                {
                  type: "message_delta",
                  delta: { stop_reason: raw, stop_sequence: null },
                  usage: { output_tokens: 3 },
                },
                { type: "message_stop" },
              ]),
            ),
          ),
      });
      expect((await collect(provider.stream(request))).at(-1)).toEqual({
        type: "stop",
        reason,
        raw,
      });
    }
  });

  it("ignores a JSON-object request, which the Messages API has no mode for", async () => {
    const captured: MessageCreateParamsStreaming[] = [];
    const provider = createAnthropicProvider({
      createStream: (params) => {
        captured.push(params);
        return Promise.resolve(replay(toolUseStream));
      },
    });
    await collect(provider.stream({ ...request, responseFormat: { type: "json_object" } }));
    expect("output_config" in (captured[0] ?? {})).toBe(false);
  });

  it("builds params without forced tool_choice or disabled thinking and echoes signed thinking", async () => {
    const captured: MessageCreateParamsStreaming[] = [];
    const provider = createAnthropicProvider({
      createStream: (params) => {
        captured.push(params);
        return Promise.resolve(replay(toolUseStream));
      },
    });
    await collect(
      provider.stream({
        ...request,
        responseFormat: {
          type: "json_schema",
          name: "plan",
          schema: z.object({ steps: z.array(z.string()) }),
        },
        messages: [
          { role: "user", content: "Plan" },
          {
            role: "assistant",
            content: "Fetching.",
            reasoning: "Plan the fetch.",
            reasoningSignature: "sig_1",
            toolCalls: [
              { id: "toolu_1", name: "web_fetch", argumentsJson: '{"url":"https://example.com"}' },
            ],
          },
          { role: "tool", toolCallId: "toolu_1", name: "web_fetch", content: "page A" },
          {
            role: "tool",
            toolCallId: "toolu_2",
            name: "web_fetch",
            content: "timeout",
            isError: true,
          },
          { role: "user", content: "Continue" },
        ],
      }),
    );
    const params = captured[0];
    expect(params?.stream).toBe(true);
    expect(params?.tool_choice).toEqual({ type: "auto" });
    expect(params?.thinking).toBeUndefined();
    expect(params?.system).toEqual([
      { type: "text", text: "You are the planner.", cache_control: { type: "ephemeral" } },
    ]);
    expect(params?.tools?.[0]).toMatchObject({
      name: "web_fetch",
      strict: true,
      input_schema: { type: "object", required: ["url"] },
    });
    expect(params?.output_config?.format).toMatchObject({
      type: "json_schema",
      schema: { type: "object" },
    });
    expect(params?.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Plan" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Plan the fetch.", signature: "sig_1" },
          { type: "text", text: "Fetching." },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "web_fetch",
            input: { url: "https://example.com" },
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "page A" },
          { type: "tool_result", tool_use_id: "toolu_2", content: "timeout", is_error: true },
          { type: "text", text: "Continue" },
        ],
      },
    ]);
  });

  it("maps SDK errors to typed provider errors", async () => {
    const rateLimited = createAnthropicProvider({
      createStream: () =>
        Promise.reject(
          new RateLimitError(429, {}, "rate limited", new Headers({ "retry-after": "3" })),
        ),
    });
    await expect(collect(rateLimited.stream(request))).rejects.toEqual(
      expect.any(RateLimitedError),
    );
    await expect(collect(rateLimited.stream(request))).rejects.toMatchObject({
      retryAfterMs: 3000,
    });

    const overloaded = createAnthropicProvider({
      createStream: () =>
        Promise.reject(new InternalServerError(529, {}, "overloaded", new Headers())),
    });
    await expect(collect(overloaded.stream(request))).rejects.toMatchObject({ status: 529 });
    await expect(collect(overloaded.stream(request))).rejects.toBeInstanceOf(ProviderHttpError);

    const slow = createAnthropicProvider({
      createStream: () => Promise.reject(new APIConnectionTimeoutError()),
    });
    await expect(collect(slow.stream(request))).rejects.toBeInstanceOf(ProviderTimeoutError);
  });
});
