import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
} from "@anthropic-ai/sdk";
import {
  type ContentBlockParam,
  type MessageCreateParamsStreaming,
  type MessageParam,
  type RawMessageStreamEvent,
  type StopReason as AnthropicStopReason,
  type Tool,
} from "@anthropic-ai/sdk/resources/messages";

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

export type AnthropicStreamFactory = (
  params: MessageCreateParamsStreaming,
  signal: AbortSignal | undefined,
) => Promise<AsyncIterable<RawMessageStreamEvent>>;

export interface AnthropicProviderOptions {
  id?: string;
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof fetch;
  createStream?: AnthropicStreamFactory;
  timeoutMs?: number;
}

export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

const STOP_REASONS: Partial<Record<string, StopReason>> = {
  end_turn: "end",
  stop_sequence: "end",
  tool_use: "tool_use",
  max_tokens: "max_tokens",
  model_context_window_exceeded: "max_tokens",
  refusal: "refusal",
  pause_turn: "pause_turn",
} satisfies Record<AnthropicStopReason, StopReason>;

function parseToolInput(argumentsJson: string): unknown {
  try {
    return JSON.parse(argumentsJson) as unknown;
  } catch {
    return {};
  }
}

function assistantBlocks(
  message: Extract<ChatMessage, { role: "assistant" }>,
): ContentBlockParam[] {
  const blocks: ContentBlockParam[] = [];
  if (message.reasoning !== undefined && message.reasoningSignature !== undefined) {
    blocks.push({
      type: "thinking",
      thinking: message.reasoning,
      signature: message.reasoningSignature,
    });
  }
  if (message.content !== "") blocks.push({ type: "text", text: message.content });
  for (const call of message.toolCalls ?? []) {
    blocks.push({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: parseToolInput(call.argumentsJson),
    });
  }
  return blocks;
}

function toAnthropicMessages(messages: readonly ChatMessage[]): MessageParam[] {
  const out: { role: "user" | "assistant"; content: ContentBlockParam[] }[] = [];
  const append = (role: "user" | "assistant", blocks: ContentBlockParam[]) => {
    const last = out.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const message of messages) {
    switch (message.role) {
      case "user":
        append("user", [{ type: "text", text: message.content }]);
        break;
      case "tool":
        append("user", [
          {
            type: "tool_result",
            tool_use_id: message.toolCallId,
            content: message.content,
            ...(message.isError === true ? { is_error: true } : {}),
          },
        ]);
        break;
      case "assistant":
        append("assistant", assistantBlocks(message));
        break;
    }
  }
  return out;
}

export function toAnthropicParams(request: ModelRequest): MessageCreateParamsStreaming {
  const params: MessageCreateParamsStreaming = {
    model: request.model,
    max_tokens: request.maxTokens,
    stream: true,
    system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
    messages: toAnthropicMessages(request.messages),
  };
  if (request.tools !== undefined && request.tools.length > 0) {
    params.tools = request.tools.map((tool): Tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: { ...toJsonSchema(tool.inputSchema), type: "object" },
      strict: true,
    }));
    params.tool_choice = { type: "auto" };
  }
  if (request.responseFormat?.type === "json_schema") {
    params.output_config = {
      format: { type: "json_schema", schema: toJsonSchema(request.responseFormat.schema) },
    };
  }
  return params;
}

function mapError(providerId: string, timeoutMs: number, error: unknown): unknown {
  if (error instanceof APIConnectionTimeoutError)
    return new ProviderTimeoutError(providerId, timeoutMs);
  if (error instanceof APIConnectionError)
    return new ProviderNetworkError(providerId, error.message);
  if (error instanceof APIError) {
    const status = typeof error.status === "number" ? error.status : 0;
    if (status === 429) {
      const headers = error.headers instanceof Headers ? error.headers : new Headers();
      return new RateLimitedError(providerId, parseRetryAfter(headers, Date.now()));
    }
    return new ProviderHttpError(providerId, status, error.message.slice(0, 300));
  }
  return error;
}

export function createAnthropicProvider(options: AnthropicProviderOptions): ModelProvider {
  const id = options.id ?? "anthropic";
  const timeoutMs = options.timeoutMs ?? 120_000;
  const apiKey = options.apiKey?.trim() ?? "";
  if (options.createStream === undefined && apiKey === "") {
    throw new Error(`Provider ${id} needs a non-empty bring-your-own API key`);
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  let client: Anthropic | undefined;
  const createStream: AnthropicStreamFactory =
    options.createStream ??
    (async (params, signal) => {
      client ??= new Anthropic({
        apiKey,
        authToken: null,
        baseURL: options.baseURL ?? ANTHROPIC_BASE_URL,
        fetch: (input, init) => fetchImpl(input, { ...init, redirect: "error" }),
        maxRetries: 0,
        timeout: timeoutMs,
      });
      return client.messages.create(params, signal === undefined ? {} : { signal });
    });

  async function* stream(
    request: ModelRequest,
    streamOptions?: StreamOptions,
  ): AsyncGenerator<ModelStreamEvent> {
    const blocks = new Map<
      number,
      { kind: "tool_use"; id: string; name: string; args: string } | { kind: "other" }
    >();
    const usage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    let stopRaw: AnthropicStopReason | undefined;

    try {
      const events = await createStream(toAnthropicParams(request), streamOptions?.signal);
      for await (const event of events) {
        switch (event.type) {
          case "message_start": {
            const start = event.message.usage;
            usage.inputTokens = start.input_tokens;
            usage.outputTokens = start.output_tokens;
            usage.cacheReadTokens = start.cache_read_input_tokens ?? 0;
            usage.cacheWriteTokens = start.cache_creation_input_tokens ?? 0;
            break;
          }
          case "content_block_start":
            if (event.content_block.type === "tool_use") {
              const block = event.content_block;
              blocks.set(event.index, {
                kind: "tool_use",
                id: block.id,
                name: block.name,
                args: "",
              });
              yield {
                type: "tool_call_delta",
                index: event.index,
                id: block.id,
                name: block.name,
                argumentsDelta: "",
              };
            } else {
              blocks.set(event.index, { kind: "other" });
            }
            break;
          case "content_block_delta": {
            const delta = event.delta;
            if (delta.type === "text_delta") yield { type: "text_delta", text: delta.text };
            else if (delta.type === "thinking_delta")
              yield { type: "reasoning_delta", text: delta.thinking };
            else if (delta.type === "signature_delta")
              yield { type: "reasoning_signature", signature: delta.signature };
            else if (delta.type === "input_json_delta") {
              const block = blocks.get(event.index);
              if (block?.kind === "tool_use") block.args += delta.partial_json;
              yield {
                type: "tool_call_delta",
                index: event.index,
                argumentsDelta: delta.partial_json,
              };
            }
            break;
          }
          case "content_block_stop": {
            const block = blocks.get(event.index);
            if (block?.kind === "tool_use") {
              yield {
                type: "tool_call_complete",
                call: {
                  id: block.id,
                  name: block.name,
                  argumentsJson: block.args === "" ? "{}" : block.args,
                },
              };
            }
            break;
          }
          case "message_delta":
            stopRaw = event.delta.stop_reason ?? stopRaw;
            usage.outputTokens = event.usage.output_tokens;
            if (typeof event.usage.input_tokens === "number")
              usage.inputTokens = event.usage.input_tokens;
            if (typeof event.usage.cache_read_input_tokens === "number") {
              usage.cacheReadTokens = event.usage.cache_read_input_tokens;
            }
            if (typeof event.usage.cache_creation_input_tokens === "number") {
              usage.cacheWriteTokens = event.usage.cache_creation_input_tokens;
            }
            break;
          case "message_stop":
            break;
        }
      }
    } catch (error) {
      throw mapError(id, timeoutMs, error);
    }

    yield { type: "usage", usage: { ...usage } };
    if (stopRaw === undefined) {
      yield { type: "stop", reason: "error", raw: "stream ended without stop_reason" };
      return;
    }
    yield { type: "stop", reason: STOP_REASONS[stopRaw] ?? "error", raw: stopRaw };
  }

  return { id, stream };
}
