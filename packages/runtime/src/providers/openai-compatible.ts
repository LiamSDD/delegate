import { z } from "zod";

import { parseSse } from "./sse";
import {
  ProviderHttpError,
  ProviderNetworkError,
  ProviderTimeoutError,
  RateLimitedError,
  parseRetryAfter,
  toJsonSchema,
  type ChatMessage,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
  type StopReason,
  type StreamOptions,
  type TokenUsage,
} from "./types";

export const QUIRK_ECHO_REASONING_CONTENT = "echo-reasoning-content";

export interface OpenAICompatibleOptions {
  id: string;
  baseUrl: string;
  chatPath?: string;
  apiKey?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

const ChunkSchema = z.object({
  choices: z
    .array(
      z.object({
        delta: z
          .object({
            content: z.string().nullish(),
            reasoning_content: z.string().nullish(),
            reasoning: z.string().nullish(),
            refusal: z.string().nullish(),
            tool_calls: z
              .array(
                z.object({
                  index: z.number().int().nonnegative(),
                  id: z.string().nullish(),
                  function: z
                    .object({ name: z.string().nullish(), arguments: z.string().nullish() })
                    .nullish(),
                }),
              )
              .nullish(),
          })
          .nullish(),
        finish_reason: z.string().nullish(),
      }),
    )
    .nullish(),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative(),
      completion_tokens: z.number().int().nonnegative(),
      prompt_tokens_details: z
        .object({ cached_tokens: z.number().int().nonnegative().nullish() })
        .nullish(),
    })
    .nullish(),
  error: z.object({ message: z.string() }).nullish(),
});

const FINISH_REASONS: Record<string, StopReason> = {
  stop: "end",
  tool_calls: "tool_use",
  function_call: "tool_use",
  length: "max_tokens",
  content_filter: "refusal",
};

function toWireMessages(request: ModelRequest): Record<string, unknown>[] {
  const echoReasoning = request.quirks?.includes(QUIRK_ECHO_REASONING_CONTENT) === true;
  const wire: Record<string, unknown>[] = [{ role: "system", content: request.system }];
  for (const message of request.messages) wire.push(toWireMessage(message, echoReasoning));
  return wire;
}

function toWireMessage(message: ChatMessage, echoReasoning: boolean): Record<string, unknown> {
  switch (message.role) {
    case "user":
      return { role: "user", content: message.content };
    case "tool":
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
    case "assistant": {
      const toolCalls = message.toolCalls ?? [];
      return {
        role: "assistant",
        content: message.content === "" && toolCalls.length > 0 ? null : message.content,
        ...(toolCalls.length > 0
          ? {
              tool_calls: toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: call.argumentsJson },
              })),
            }
          : {}),
        ...(echoReasoning ? { reasoning_content: message.reasoning ?? "" } : {}),
      };
    }
  }
}

function toWireBody(request: ModelRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: toWireMessages(request),
    max_tokens: request.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.tools !== undefined && request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: toJsonSchema(tool.inputSchema),
      },
    }));
  }
  if (request.responseFormat?.type === "json_schema") {
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: request.responseFormat.name,
        schema: toJsonSchema(request.responseFormat.schema),
        strict: true,
      },
    };
  }
  return body;
}

async function snippet(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  return text.slice(0, 300);
}

export function createOpenAICompatibleProvider(options: OpenAICompatibleOptions): ModelProvider {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const now = options.now ?? Date.now;
  const url = `${options.baseUrl.replace(/\/+$/, "")}${options.chatPath ?? "/chat/completions"}`;

  async function open(
    request: ModelRequest,
    streamOptions: StreamOptions | undefined,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    const signal =
      streamOptions?.signal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, streamOptions.signal]);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
    };
    if (options.apiKey !== undefined && options.apiKey !== "")
      headers.authorization = `Bearer ${options.apiKey}`;
    try {
      return await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(toWireBody(request)),
        signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new ProviderTimeoutError(options.id, timeoutMs);
      if (streamOptions?.signal?.aborted === true) throw error;
      throw new ProviderNetworkError(
        options.id,
        error instanceof Error ? error.message : "request failed",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async function* stream(
    request: ModelRequest,
    streamOptions?: StreamOptions,
  ): AsyncGenerator<ModelStreamEvent> {
    const response = await open(request, streamOptions);
    if (response.status === 429) {
      const retryAfterMs = parseRetryAfter(response.headers, now());
      await response.body?.cancel().catch(() => undefined);
      throw new RateLimitedError(options.id, retryAfterMs);
    }
    if (!response.ok)
      throw new ProviderHttpError(options.id, response.status, await snippet(response));
    if (response.body === null)
      throw new ProviderHttpError(options.id, response.status, "empty body");

    const calls = new Map<number, { id: string; name: string; args: string }>();
    let usage: TokenUsage | undefined;
    let finish: string | undefined;
    let flushed = false;

    const flushCalls = function* (): Generator<ModelStreamEvent> {
      if (flushed) return;
      flushed = true;
      for (const [index, call] of [...calls.entries()].sort(([a], [b]) => a - b)) {
        yield {
          type: "tool_call_complete",
          call: {
            id: call.id === "" ? `call_${index}` : call.id,
            name: call.name,
            argumentsJson: call.args,
          },
        };
      }
    };

    for await (const message of parseSse(response.body)) {
      if (message.data === "[DONE]") break;
      let json: unknown;
      try {
        json = JSON.parse(message.data);
      } catch {
        yield { type: "stop", reason: "error", raw: "invalid JSON chunk" };
        return;
      }
      const chunk = ChunkSchema.safeParse(json);
      if (!chunk.success) {
        yield { type: "stop", reason: "error", raw: "unexpected chunk shape" };
        return;
      }
      if (chunk.data.error) {
        yield { type: "stop", reason: "error", raw: chunk.data.error.message };
        return;
      }
      if (chunk.data.usage) {
        const cached = chunk.data.usage.prompt_tokens_details?.cached_tokens ?? 0;
        usage = {
          inputTokens: Math.max(0, chunk.data.usage.prompt_tokens - cached),
          outputTokens: chunk.data.usage.completion_tokens,
          cacheReadTokens: cached,
          cacheWriteTokens: 0,
        };
      }
      for (const choice of chunk.data.choices ?? []) {
        const delta = choice.delta;
        const reasoning = delta?.reasoning_content ?? delta?.reasoning;
        if (reasoning) yield { type: "reasoning_delta", text: reasoning };
        if (delta?.content) yield { type: "text_delta", text: delta.content };
        for (const toolDelta of delta?.tool_calls ?? []) {
          const existing = calls.get(toolDelta.index) ?? { id: "", name: "", args: "" };
          const id = toolDelta.id ?? undefined;
          const name = toolDelta.function?.name ?? undefined;
          const argumentsDelta = toolDelta.function?.arguments ?? "";
          calls.set(toolDelta.index, {
            id: id ?? existing.id,
            name: existing.name + (name ?? ""),
            args: existing.args + argumentsDelta,
          });
          yield {
            type: "tool_call_delta",
            index: toolDelta.index,
            ...(id === undefined ? {} : { id }),
            ...(name === undefined ? {} : { name }),
            argumentsDelta,
          };
        }
        if (choice.finish_reason) {
          finish = choice.finish_reason;
          yield* flushCalls();
        }
      }
    }

    yield* flushCalls();
    if (usage !== undefined) yield { type: "usage", usage };
    if (finish === undefined) {
      yield { type: "stop", reason: "error", raw: "stream ended without finish_reason" };
      return;
    }
    yield { type: "stop", reason: FINISH_REASONS[finish] ?? "error", raw: finish };
  }

  return { id: options.id, stream };
}
