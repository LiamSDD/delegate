import { readFileSync } from "node:fs";

import { parsePromptFile, type PromptFile } from "@delegate/runtime";
import { z } from "zod";

import { type XrayCase } from "../datasets/xray";

export const JUDGE_PROMPT_FILE = "xray-judge.v1.md";
export const JUDGE_CRITERIA = [
  "accuracy",
  "specificity",
  "actionability",
  "citationFaithfulness",
] as const;
export type JudgeCriterion = (typeof JUDGE_CRITERIA)[number];

const CriterionSchema = z.object({
  score: z.coerce.number().int().min(1).max(5),
  rationale: z.string().trim().min(1).max(400),
});

export const JudgeVerdictSchema = z.object({
  accuracy: CriterionSchema,
  specificity: CriterionSchema,
  actionability: CriterionSchema,
  citationFaithfulness: CriterionSchema,
  facts: z
    .array(
      z.object({
        id: z.string().min(1),
        verdict: z.enum(["supported", "contradicted", "absent"]),
      }),
    )
    .default([]),
});
export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

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

export interface JudgeResult {
  verdict: JudgeVerdict;
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
const MAX_QUOTES_PER_SOURCE = 4;
const MAX_QUOTE_CHARS = 200;

export function loadJudgePrompt(): PromptFile {
  return parsePromptFile(
    JUDGE_PROMPT_FILE,
    readFileSync(new URL(`../../prompts/${JUDGE_PROMPT_FILE}`, import.meta.url), "utf8"),
  );
}

const LooseClaimSchema = z.object({ text: z.string(), citations: z.array(z.string()).default([]) });
const BriefViewSchema = z.object({
  company: z.object({ name: z.string(), url: z.string(), oneLiner: z.unknown() }),
  sources: z.array(
    z.object({ sourceId: z.string(), url: z.string(), quotes: z.array(z.string()).default([]) }),
  ),
  sections: z.record(z.string(), z.unknown()),
});

function claimLines(value: unknown, into: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) claimLines(item, into);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const claim = LooseClaimSchema.safeParse(value);
  if (claim.success) {
    into.push(`- ${claim.data.text} [${claim.data.citations.join(", ")}]`);
    return;
  }
  const record = value as Record<string, unknown>;
  if (record.status === "insufficient_evidence") {
    into.push(`- (insufficient_evidence) ${typeof record.note === "string" ? record.note : ""}`);
    return;
  }
  for (const [key, nested] of Object.entries(record)) {
    if (key === "status") continue;
    if (typeof nested === "string" && key === "name") into.push(`- competitor: ${nested}`);
    else claimLines(nested, into);
  }
}

export function renderJudgeInput(evalCase: XrayCase, brief: unknown): string {
  const view = BriefViewSchema.parse(brief);
  const lines = [
    `Company: ${view.company.name} (${view.company.url})`,
    "",
    "## Expected facts",
    ...evalCase.expectedFacts.map((fact) => `- ${fact.id}: ${fact.proposition}`),
    "",
    "## Brief claims",
  ];
  const oneLiner: string[] = [];
  claimLines(view.company.oneLiner, oneLiner);
  if (oneLiner.length > 0) lines.push("### oneLiner", ...oneLiner);
  for (const [key, section] of Object.entries(view.sections)) {
    const sectionLines: string[] = [];
    claimLines(section, sectionLines);
    lines.push(`### ${key}`, ...sectionLines);
  }
  lines.push("", "## Cited sources and kept quotes");
  for (const source of view.sources) {
    lines.push(`[${source.sourceId}] ${source.url}`);
    for (const quote of source.quotes.slice(0, MAX_QUOTES_PER_SOURCE))
      lines.push(`  > ${quote.slice(0, MAX_QUOTE_CHARS)}`);
  }
  return lines.join("\n");
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

function validate(text: string): { ok: true; value: JudgeVerdict } | { ok: false; issues: string } {
  const json = parseJson(text);
  if (json === undefined) return { ok: false, issues: "- (root): no parseable JSON object" };
  const parsed = JudgeVerdictSchema.safeParse(json);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues
      .slice(0, 10)
      .map((issue) => `- ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n"),
  };
}

export async function judgeXray(options: {
  completer: JudgeCompleter;
  prompt: PromptFile;
  evalCase: XrayCase;
  brief: unknown;
}): Promise<JudgeResult> {
  const { completer, prompt } = options;
  const messages: JudgeMessage[] = [
    { role: "user", content: renderJudgeInput(options.evalCase, options.brief) },
  ];
  const base = { promptName: prompt.name, promptVersion: prompt.version };
  const first = await completer.complete({
    system: prompt.body,
    messages,
    maxTokens: JUDGE_MAX_TOKENS,
  });
  const firstCheck = validate(first.text);
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
  const secondCheck = validate(second.text);
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

export function normalisedJudgeScores(verdict: JudgeVerdict): Record<JudgeCriterion, number> {
  return Object.fromEntries(
    JUDGE_CRITERIA.map((criterion) => [criterion, (verdict[criterion].score - 1) / 4]),
  ) as Record<JudgeCriterion, number>;
}
