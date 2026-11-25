import { type z } from "zod";

import { BudgetExceededError } from "../budget";
import { type ModelRole } from "../events";
import { type ChatMessage } from "../providers/types";
import { NoModelAvailableError, estimatePromptTokens } from "../router";
import { type RunContext } from "./context";
import { joinContinuation, readJson } from "./json-repair";
import {
  ModelStreamError,
  callModel,
  type ModelCallResult,
  type QualityRequest,
} from "./model-call";
import { describeIssues, fitToSchema } from "./schema-repair";

const MAX_ECHOED_ANSWER_CHARS = 12_000;
export const STREAM_RETRY_BACKOFF_MS = 1_000;

export class StructuredOutputError extends Error {
  override readonly name = "StructuredOutputError";
  constructor(
    message: string,
    readonly issues: string,
  ) {
    super(message);
  }
}

export interface StructuredCallOptions<T> {
  role: ModelRole;
  stepId?: string | undefined;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  maxTokens: number;
  temperature?: number;
  quality?: QualityRequest | undefined;
}

export interface StructuredResult<T> {
  value: T;
  repaired: boolean;
  calls: ModelCallResult[];
}

export function extractJson(text: string): unknown {
  const reading = readJson(text);
  return reading.ok ? reading.value : undefined;
}

type Reading<T> =
  { ok: true; value: T; truncated: boolean } | { ok: false; issues: string; truncated: boolean };

const EMPTY_ANSWER =
  "- (root): the answer was empty; the model returned only reasoning. Reply with the JSON object itself.";
const CONTINUE_OR_SHORTEN =
  "Your previous answer was cut off before the JSON was complete. Either continue exactly where it stopped, without repeating anything, or, if the complete answer will not fit, reply with the whole JSON object again in a shorter form. No prose, no code fences.";

function read<T>(
  schema: z.ZodType<T>,
  result: ModelCallResult,
  text: string = result.text,
): Reading<T> {
  if (result.stopReason === "refusal") {
    throw new StructuredOutputError(
      `${result.provider}/${result.model} refused the request`,
      "refusal",
    );
  }
  const stopped = result.stopReason === "max_tokens";
  if (text.trim() === "") return { ok: false, issues: EMPTY_ANSWER, truncated: false };
  const json = readJson(text);
  const truncated = stopped || json.truncated;
  if (!json.ok) {
    const note = truncated ? " The answer was cut off at the token limit; be more concise." : "";
    return {
      ok: false,
      issues: `- (root): the answer did not contain a parseable JSON value.${note}`,
      truncated,
    };
  }
  const fitted = fitToSchema(schema, json.value);
  return fitted.ok
    ? { ok: true, value: fitted.value, truncated: json.truncated }
    : { ok: false, issues: describeIssues(fitted.error), truncated: json.truncated };
}

function readContinuation<T>(
  schema: z.ZodType<T>,
  partial: ModelCallResult,
  reply: ModelCallResult,
): Reading<T> {
  const joined = read(schema, reply, joinContinuation(partial.text, reply.text));
  if (joined.ok && !joined.truncated) return joined;
  const alone = read(schema, reply);
  if (alone.ok) return alone;
  return joined.ok ? joined : alone;
}

function echoed(text: string, keepEnd: boolean): string {
  if (text.length <= MAX_ECHOED_ANSWER_CHARS) return text;
  return keepEnd ? text.slice(-MAX_ECHOED_ANSWER_CHARS) : text.slice(0, MAX_ECHOED_ANSWER_CHARS);
}

function affordable<T>(
  ctx: RunContext,
  options: StructuredCallOptions<T>,
  messages: ChatMessage[],
): boolean {
  const prompt = estimatePromptTokens({
    system: options.system,
    messages,
    maxTokens: options.maxTokens,
  });
  return prompt <= ctx.budget.remaining(options.stepId).tokens;
}

async function ask<T>(
  ctx: RunContext,
  options: StructuredCallOptions<T>,
  messages: ChatMessage[],
  quality?: QualityRequest,
): Promise<ModelCallResult> {
  const call = (preference: QualityRequest | undefined) =>
    callModel(ctx, {
      role: options.role,
      stepId: options.stepId,
      ...(preference === undefined ? {} : { quality: preference }),
      request: {
        system: options.system,
        messages,
        maxTokens: options.maxTokens,
        responseFormat: { type: "json_object" },
        ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      },
    });
  try {
    return await call(quality);
  } catch (error) {
    if (!(error instanceof ModelStreamError) || !affordable(ctx, options, messages)) throw error;
    await ctx.sleep(STREAM_RETRY_BACKOFF_MS);
    return call(undefined);
  }
}

export async function callStructured<T>(
  ctx: RunContext,
  options: StructuredCallOptions<T>,
): Promise<StructuredResult<T>> {
  const messages: ChatMessage[] = [{ role: "user", content: options.user }];
  const first = await ask(ctx, options, messages, options.quality);
  const firstCheck = read(options.schema, first);
  if (firstCheck.ok) return { value: firstCheck.value, repaired: false, calls: [first] };

  const continuing = firstCheck.truncated && first.text.trim() !== "";
  const followUp: ChatMessage[] = [
    ...messages,
    { role: "assistant", content: echoed(first.text, continuing) },
    {
      role: "user",
      content: continuing
        ? CONTINUE_OR_SHORTEN
        : `Your previous answer could not be used because it failed validation:\n${firstCheck.issues}\n\nReply with only the corrected JSON object. No prose, no code fences.`,
    },
  ];
  if (!affordable(ctx, options, followUp))
    throw new StructuredOutputError(
      "Model output failed validation and the step budget cannot pay for a repair turn",
      firstCheck.issues,
    );
  const second = await ask(ctx, options, followUp);
  const secondCheck = continuing
    ? readContinuation(options.schema, first, second)
    : read(options.schema, second);
  if (secondCheck.ok) return { value: secondCheck.value, repaired: true, calls: [first, second] };
  throw new StructuredOutputError(
    "Model output failed validation after one repair attempt",
    secondCheck.issues,
  );
}

export interface StructuredReview<R> {
  result: R;
  score: number;
  feedback?: string | undefined;
}

export interface ReviewedCallOptions<T, R> extends StructuredCallOptions<T> {
  review: (value: T) => StructuredReview<R>;
  canRevise?: () => boolean;
}

export interface ReviewedResult<R> {
  result: R;
  revised: boolean;
  feedback?: string | undefined;
  calls: ModelCallResult[];
}

function revisionUnavailable(error: unknown): boolean {
  return (
    error instanceof StructuredOutputError ||
    error instanceof NoModelAvailableError ||
    error instanceof ModelStreamError ||
    (error instanceof BudgetExceededError && error.scope === "step")
  );
}

export async function callStructuredReviewed<T, R>(
  ctx: RunContext,
  options: ReviewedCallOptions<T, R>,
): Promise<ReviewedResult<R>> {
  const first = await callStructured(ctx, options);
  const firstReview = options.review(first.value);
  const kept = (calls: ModelCallResult[]): ReviewedResult<R> => ({
    result: firstReview.result,
    revised: false,
    ...(firstReview.feedback === undefined ? {} : { feedback: firstReview.feedback }),
    calls,
  });
  const answered = first.calls.at(-1);
  if (
    firstReview.feedback === undefined ||
    answered === undefined ||
    options.canRevise?.() === false
  )
    return kept(first.calls);
  const history: ChatMessage[] = [
    { role: "user", content: options.user },
    { role: "assistant", content: echoed(answered.text, false) },
    {
      role: "user",
      content: `Your answer parsed, but code rejected parts of it:\n${firstReview.feedback}\n\nReply with the complete corrected JSON object in the same shape: fix or replace every rejected item, keep the accepted ones. No prose, no code fences.`,
    },
  ];
  if (!affordable(ctx, options, history)) return kept(first.calls);
  let second: ModelCallResult;
  try {
    second = await ask(ctx, options, history);
  } catch (error) {
    if (!revisionUnavailable(error)) throw error;
    return kept(first.calls);
  }
  const calls = [...first.calls, second];
  let check: Reading<T>;
  try {
    check = read(options.schema, second);
  } catch (error) {
    if (!revisionUnavailable(error)) throw error;
    return kept(calls);
  }
  if (!check.ok) return kept(calls);
  const secondReview = options.review(check.value);
  if (secondReview.score <= firstReview.score) return kept(calls);
  return {
    result: secondReview.result,
    revised: true,
    ...(secondReview.feedback === undefined ? {} : { feedback: secondReview.feedback }),
    calls,
  };
}
