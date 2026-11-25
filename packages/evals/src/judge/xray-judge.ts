import { type PromptFile } from "@delegate/runtime";
import { z } from "zod";

import { type XrayCase } from "../datasets/xray";
import {
  CriterionScoreSchema,
  loadEvalPrompt,
  runJudge,
  type JudgeCompleter,
  type JudgeOutcome,
} from "./rubric-judge";

export {
  JUDGE_MAX_TOKENS,
  JudgeOutputError,
  type JudgeCompleter,
  type JudgeMessage,
} from "./rubric-judge";

export const JUDGE_PROMPT_FILE = "xray-judge.v1.md";
export const JUDGE_CRITERIA = [
  "accuracy",
  "specificity",
  "actionability",
  "citationFaithfulness",
] as const;
export type JudgeCriterion = (typeof JUDGE_CRITERIA)[number];

const CriterionSchema = CriterionScoreSchema;

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

export type JudgeResult = JudgeOutcome<JudgeVerdict>;

const MAX_QUOTES_PER_SOURCE = 4;
const MAX_QUOTE_CHARS = 200;

export function loadJudgePrompt(): PromptFile {
  return loadEvalPrompt(JUDGE_PROMPT_FILE);
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

export async function judgeXray(options: {
  completer: JudgeCompleter;
  prompt: PromptFile;
  evalCase: XrayCase;
  brief: unknown;
}): Promise<JudgeResult> {
  return runJudge({
    completer: options.completer,
    prompt: options.prompt,
    schema: JudgeVerdictSchema,
    input: renderJudgeInput(options.evalCase, options.brief),
  });
}

export function normalisedJudgeScores(verdict: JudgeVerdict): Record<JudgeCriterion, number> {
  return Object.fromEntries(
    JUDGE_CRITERIA.map((criterion) => [criterion, (verdict[criterion].score - 1) / 4]),
  ) as Record<JudgeCriterion, number>;
}
