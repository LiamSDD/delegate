import { z } from "zod";

export interface ToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export type ChatMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string;
      toolCalls?: ToolCall[];
      reasoning?: string;
      reasoningSignature?: string;
    }
  | { role: "tool"; toolCallId: string; name: string; content: string; isError?: boolean };

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodType;
}

export type ResponseFormat =
  { type: "text" } | { type: "json_schema"; name: string; schema: z.ZodType };

export interface ModelRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  maxTokens: number;
  tools?: ToolDefinition[];
  responseFormat?: ResponseFormat;
  temperature?: number;
  quirks?: readonly string[];
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const STOP_REASONS = ["end", "tool_use", "max_tokens", "refusal", "error"] as const;
export type StopReason = (typeof STOP_REASONS)[number];

export type ModelStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "reasoning_signature"; signature: string }
  | { type: "tool_call_delta"; index: number; id?: string; name?: string; argumentsDelta: string }
  | { type: "tool_call_complete"; call: ToolCall }
  | { type: "usage"; usage: TokenUsage }
  | { type: "stop"; reason: StopReason; raw?: string };

export interface StreamOptions {
  signal?: AbortSignal;
}

export interface ModelProvider {
  readonly id: string;
  stream(request: ModelRequest, options?: StreamOptions): AsyncIterable<ModelStreamEvent>;
}

export class ProviderError extends Error {
  constructor(
    readonly providerId: string,
    message: string,
  ) {
    super(`${providerId}: ${message}`);
  }
}

export class RateLimitedError extends ProviderError {
  override readonly name = "RateLimitedError";
  constructor(
    providerId: string,
    readonly retryAfterMs?: number,
  ) {
    super(
      providerId,
      retryAfterMs === undefined ? "rate limited" : `rate limited, retry after ${retryAfterMs} ms`,
    );
  }
}

export class ProviderHttpError extends ProviderError {
  override readonly name = "ProviderHttpError";
  constructor(
    providerId: string,
    readonly status: number,
    readonly bodySnippet: string,
  ) {
    super(providerId, `HTTP ${status}${bodySnippet === "" ? "" : `: ${bodySnippet}`}`);
  }
}

export class ProviderTimeoutError extends ProviderError {
  override readonly name = "ProviderTimeoutError";
  constructor(
    providerId: string,
    readonly timeoutMs: number,
  ) {
    super(providerId, `no response within ${timeoutMs} ms`);
  }
}

export class ProviderNetworkError extends ProviderError {
  override readonly name = "ProviderNetworkError";
}

export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

export function parseRetryAfter(headers: Headers, now: number): number | undefined {
  const milliseconds = headers.get("retry-after-ms");
  if (milliseconds !== null && /^\d+(\.\d+)?$/.test(milliseconds.trim())) {
    return Math.ceil(Number(milliseconds));
  }
  const value = headers.get("retry-after");
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.ceil(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}
