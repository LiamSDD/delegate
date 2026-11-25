import { readFileSync } from "node:fs";

import { parsePromptFile, type PromptFile } from "@delegate/runtime";
import { z } from "zod";

export interface JudgeMessage {
  role: "user" | "assistant";
  content: string;
}

export interface JudgeCompleter {
  complete(request: {
    system: string;
    messages: JudgeMessage[];
    maxTokens: number;
  }): Promise<{ text: string; provider: string; model: string }>;
}

export interface JudgeOutcome<V> {
  verdict: V;
  provider: string;
  model: string;
  promptName: string;
  promptVersion: number;
  repaired: boolean;
}

export class JudgeOutputError extends Error {
  override readonly name = "JudgeOutputError";
}

export const JUDGE_MAX_TOKENS = 1_400;

export const CriterionScoreSchema = z.object({
  score: z.coerce.number().int().min(1).max(5),
  rationale: z.string().trim().min(1).max(400),
});

export type RubricVerdict = Record<string, { score: number; rationale: string }>;

export function rubricVerdictSchema(criteria: readonly string[]) {
  return z.object(
    Object.fromEntries(criteria.map((criterion) => [criterion, CriterionScoreSchema])),
  );
}

export function loadEvalPrompt(file: string): PromptFile {
  return parsePromptFile(
    file,
    readFileSync(new URL(`../../prompts/${file}`, import.meta.url), "utf8"),
  );
}

function parseJson(text: string): unknown {
  const attempts = [
    text.trim(),
    /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1]?.trim(),
    text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1),
  ];
  for (const candidate of attempts) {
    if (candidate === undefined || candidate === "") continue;
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      continue;
    }
  }
  return undefined;
}

function validate<V>(
  schema: z.ZodType<V>,
  text: string,
): { ok: true; value: V } | { ok: false; issues: string } {
  const json = parseJson(text);
  if (json === undefined) return { ok: false, issues: "- (root): no parseable JSON object" };
  const parsed = schema.safeParse(json);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues
      .slice(0, 10)
      .map((issue) => `- ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n"),
  };
}

export async function runJudge<V>(options: {
  completer: JudgeCompleter;
  prompt: PromptFile;
  schema: z.ZodType<V>;
  input: string;
}): Promise<JudgeOutcome<V>> {
  const { completer, prompt, schema } = options;
  const messages: JudgeMessage[] = [{ role: "user", content: options.input }];
  const base = { promptName: prompt.name, promptVersion: prompt.version };
  const first = await completer.complete({
    system: prompt.body,
    messages,
    maxTokens: JUDGE_MAX_TOKENS,
  });
  const firstCheck = validate(schema, first.text);
  if (firstCheck.ok)
    return {
      ...base,
      verdict: firstCheck.value,
      provider: first.provider,
      model: first.model,
      repaired: false,
    };
  const second = await completer.complete({
    system: prompt.body,
    messages: [
      ...messages,
      { role: "assistant", content: first.text.slice(0, 4_000) },
      {
        role: "user",
        content: `Your answer failed validation:\n${firstCheck.issues}\n\nReply with only the corrected JSON object.`,
      },
    ],
    maxTokens: JUDGE_MAX_TOKENS,
  });
  const secondCheck = validate(schema, second.text);
  if (secondCheck.ok)
    return {
      ...base,
      verdict: secondCheck.value,
      provider: second.provider,
      model: second.model,
      repaired: true,
    };
  throw new JudgeOutputError(
    `Judge output failed validation after one repair:\n${secondCheck.issues}`,
  );
}

export function verdictScores(
  verdict: unknown,
  criteria: readonly string[],
): Record<string, number> | undefined {
  const parsed = rubricVerdictSchema(criteria).safeParse(verdict);
  if (!parsed.success) return undefined;
  const scores = parsed.data;
  return Object.fromEntries(
    criteria.map((criterion) => [criterion, scores[criterion]?.score ?? 1]),
  );
}

export function normaliseScores(scores: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(scores).map(([criterion, score]) => [criterion, (score - 1) / 4]),
  );
}
