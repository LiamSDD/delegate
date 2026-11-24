import { costMicroUsd, priceFor } from "../budget";
import { type ModelRole, type Usage } from "../events";
import { type ChainEntry } from "../models";
import { type StopReason, type ToolCall, type TokenUsage } from "../providers/types";
import { NoModelAvailableError, type RoutedStream, type RouterRequest } from "../router";
import { RunAbortedError, type RunContext } from "./context";

export const DEFAULT_RATE_LIMIT_PATIENCE_MS = 45_000;
const RATE_LIMIT_SLACK_MS = 50;

export interface ModelCallOptions {
  role: ModelRole;
  stepId?: string | undefined;
  request: RouterRequest;
  onText?: (text: string) => void;
  onStreamEnd?: () => void;
  maxRateLimitWaitMs?: number;
}

export interface ModelCallResult {
  text: string;
  reasoning: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  stopDetail?: string;
  usage: Usage;
  provider: string;
  model: string;
  entry: ChainEntry;
}

export class ModelStreamError extends Error {
  override readonly name = "ModelStreamError";
  constructor(
    readonly provider: string,
    readonly model: string,
    message: string,
  ) {
    super(`${provider}/${model}: ${message}`);
  }
}

export const RATE_LIMIT_BACKOFF_MS = 3_000;

function retryableWait(error: NoModelAvailableError, retry: number): number | undefined {
  const waits = error.attempts
    .filter((attempt) => attempt.reason === "rate_limited" || attempt.reason === "unhealthy")
    .map((attempt) => attempt.retryAfterMs ?? RATE_LIMIT_BACKOFF_MS * 2 ** retry);
  return waits.length === 0 ? undefined : Math.min(...waits);
}

async function openPatiently(ctx: RunContext, options: ModelCallOptions): Promise<RoutedStream> {
  const patience = options.maxRateLimitWaitMs ?? DEFAULT_RATE_LIMIT_PATIENCE_MS;
  let waited = 0;
  let retries = 0;
  for (;;) {
    if (ctx.signal?.aborted === true) throw new RunAbortedError();
    try {
      return await ctx.router.open(options.role, options.request, {
        classification: ctx.classification,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      });
    } catch (error) {
      if (!(error instanceof NoModelAvailableError)) throw error;
      const wait = retryableWait(error, retries);
      retries += 1;
      if (wait === undefined || waited + wait > patience) throw error;
      await ctx.sleep(wait + RATE_LIMIT_SLACK_MS);
      waited += wait + RATE_LIMIT_SLACK_MS;
    }
  }
}

function toUsage(
  usage: TokenUsage,
  estimated: boolean,
  provider: string,
  model: string,
  cost: number,
): Usage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    costMicroUsd: cost,
    provider,
    model,
    ...(estimated ? { estimated: true } : {}),
  };
}

export async function callModel(
  ctx: RunContext,
  options: ModelCallOptions,
): Promise<ModelCallResult> {
  const release = await ctx.gate.acquire(options.role);
  try {
    return await streamCall(ctx, options);
  } finally {
    release();
  }
}

async function streamCall(ctx: RunContext, options: ModelCallOptions): Promise<ModelCallResult> {
  ctx.attributeTo(options.stepId);
  const routed = await openPatiently(ctx, options);
  let text = "";
  let reasoning = "";
  const toolCalls: ToolCall[] = [];
  let tokenUsage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  let estimated = false;
  let stopReason: StopReason = "error";
  let stopDetail: string | undefined;
  try {
    for await (const event of routed.events) {
      switch (event.type) {
        case "text_delta":
          text += event.text;
          options.onText?.(event.text);
          break;
        case "reasoning_delta":
          reasoning += event.text;
          break;
        case "tool_call_complete":
          toolCalls.push(event.call);
          break;
        case "usage":
          tokenUsage = event.usage;
          estimated = event.estimated === true;
          break;
        case "stop":
          stopReason = event.reason;
          stopDetail = event.raw;
          break;
        case "tool_call_delta":
        case "reasoning_signature":
          break;
      }
    }
  } catch (error) {
    if (ctx.signal?.aborted === true) throw new RunAbortedError();
    throw new ModelStreamError(
      routed.provider,
      routed.model,
      error instanceof Error ? error.message : "stream failed",
    );
  }
  options.onStreamEnd?.();
  const cost = costMicroUsd(priceFor(ctx.config, routed.provider, routed.model), tokenUsage);
  const usage = toUsage(tokenUsage, estimated, routed.provider, routed.model, cost);
  await ctx.emitter.emit({
    runId: ctx.runId,
    type: "usage.updated",
    ...(options.stepId === undefined ? {} : { stepId: options.stepId }),
    payload: usage,
  });
  ctx.budget.charge(usage, options.stepId);
  return {
    text,
    reasoning,
    toolCalls,
    stopReason,
    ...(stopDetail === undefined ? {} : { stopDetail }),
    usage,
    provider: routed.provider,
    model: routed.model,
    entry: routed.entry,
  };
}
