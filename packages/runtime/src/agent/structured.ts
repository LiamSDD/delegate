import { type z } from "zod";

import { BudgetExceededError } from "../budget";
import { type ModelRole } from "../events";
import { type ChatMessage } from "../providers/types";
import { NoModelAvailableError } from "../router";
import { type RunContext } from "./context";
import {
  ModelStreamError,
  callModel,
  type ModelCallResult,
  type QualityRequest,
} from "./model-call";

const MAX_ISSUES_IN_REPAIR = 12;
const MAX_ECHOED_ANSWER_CHARS = 12_000;
const MAX_CLOSING_CANDIDATES = 20;

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

function parseStrict(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function withoutTrailingCommas(text: string): string {
  return text.replace(/,\s*([}\]])/g, "$1");
}

function quoteBareKeys(text: string): string {
  return text.replace(/([{,]\s*)"?([A-Za-z_][A-Za-z0-9_]*)"?\s*:/g, '$1"$2":');
}

function tryParse(text: string): unknown {
  return (
    parseStrict(text) ??
    parseStrict(withoutTrailingCommas(text)) ??
    parseStrict(withoutTrailingCommas(quoteBareKeys(text)))
  );
}

function closeUnbalanced(text: string): string {
  const open: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") open.push("}");
    else if (char === "[") open.push("]");
    else if ((char === "}" || char === "]") && open.at(-1) === char) open.pop();
  }
  const body = inString ? `${text}"` : text.replace(/[\s,]+$/, "");
  return body + open.reverse().join("");
}

export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const direct = tryParse(trimmed);
  if (direct !== undefined) return direct;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)?.[1];
  if (fenced !== undefined) {
    const parsed = tryParse(fenced.trim());
    if (parsed !== undefined) return parsed;
  }
  const start = trimmed.search(/[{[]/);
  if (start === -1) return undefined;
  const balanced = tryParse(closeUnbalanced(trimmed.slice(start)));
  if (balanced !== undefined) return balanced;
  const closer = trimmed[start] === "{" ? "}" : "]";
  let end = trimmed.lastIndexOf(closer);
  for (let attempt = 0; end > start && attempt < MAX_CLOSING_CANDIDATES; attempt += 1) {
    const parsed = tryParse(trimmed.slice(start, end + 1));
    if (parsed !== undefined) return parsed;
    end = trimmed.lastIndexOf(closer, end - 1);
  }
  return undefined;
}

type Issue = z.core.$ZodIssue;

function flattenIssues(
  issues: readonly Issue[],
  prefix: readonly PropertyKey[],
): { path: PropertyKey[]; message: string }[] {
  return issues.flatMap((issue) => {
    const path = [...prefix, ...issue.path];
    if (issue.code === "invalid_union" && issue.errors.length > 0) {
      const closest = [...issue.errors].sort((a, b) => a.length - b.length)[0] ?? [];
      if (closest.length > 0) return flattenIssues(closest, path);
    }
    return [{ path, message: issue.message }];
  });
}

function describeIssues(error: z.ZodError): string {
  return flattenIssues(error.issues, [])
    .slice(0, MAX_ISSUES_IN_REPAIR)
    .map(
      (issue) =>
        `- ${issue.path.length === 0 ? "(root)" : issue.path.map(String).join(".")}: ${issue.message}`,
    )
    .join("\n");
}

function validate<T>(
  schema: z.ZodType<T>,
  result: ModelCallResult,
): { ok: true; value: T } | { ok: false; issues: string } {
  if (result.stopReason === "refusal") {
    throw new StructuredOutputError(
      `${result.provider}/${result.model} refused the request`,
      "refusal",
    );
  }
  if (result.text.trim() === "") {
    return {
      ok: false,
      issues:
        "- (root): the answer was empty; the model returned only reasoning. Reply with the JSON object itself.",
    };
  }
  const json = extractJson(result.text);
  if (json === undefined) {
    const truncated =
      result.stopReason === "max_tokens"
        ? " The answer was cut off at the token limit; be more concise."
        : "";
    return {
      ok: false,
      issues: `- (root): the answer did not contain a parseable JSON value.${truncated}`,
    };
  }
  const parsed = schema.safeParse(json);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, issues: describeIssues(parsed.error) };
}

export async function callStructured<T>(
  ctx: RunContext,
  options: StructuredCallOptions<T>,
): Promise<StructuredResult<T>> {
  const messages: ChatMessage[] = [{ role: "user", content: options.user }];
  const request = (history: ChatMessage[], quality?: QualityRequest) => ({
    role: options.role,
    stepId: options.stepId,
    ...(quality === undefined ? {} : { quality }),
    request: {
      system: options.system,
      messages: history,
      maxTokens: options.maxTokens,
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    },
  });
  const first = await callModel(ctx, request(messages, options.quality));
  const firstCheck = validate(options.schema, first);
  if (firstCheck.ok) return { value: firstCheck.value, repaired: false, calls: [first] };

  const repairHistory: ChatMessage[] = [
    ...messages,
    { role: "assistant", content: first.text.slice(0, MAX_ECHOED_ANSWER_CHARS) },
    {
      role: "user",
      content: `Your previous answer could not be used because it failed validation:\n${firstCheck.issues}\n\nReply with only the corrected JSON object. No prose, no code fences.`,
    },
  ];
  const second = await callModel(ctx, request(repairHistory));
  const secondCheck = validate(options.schema, second);
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
    { role: "assistant", content: answered.text.slice(0, MAX_ECHOED_ANSWER_CHARS) },
    {
      role: "user",
      content: `Your answer parsed, but code rejected parts of it:\n${firstReview.feedback}\n\nReply with the complete corrected JSON object in the same shape: fix or replace every rejected item, keep the accepted ones. No prose, no code fences.`,
    },
  ];
  let second: ModelCallResult;
  try {
    second = await callModel(ctx, {
      role: options.role,
      stepId: options.stepId,
      request: {
        system: options.system,
        messages: history,
        maxTokens: options.maxTokens,
        ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      },
    });
  } catch (error) {
    if (!revisionUnavailable(error)) throw error;
    return kept(first.calls);
  }
  const calls = [...first.calls, second];
  let check: ReturnType<typeof validate<T>>;
  try {
    check = validate(options.schema, second);
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
