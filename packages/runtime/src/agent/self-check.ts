import { z } from "zod";

import { BudgetExceededError } from "../budget";
import { type ModelRole, type PlanStep } from "../events";
import { type PromptFile } from "../prompts";
import { NoModelAvailableError, estimatePromptTokens } from "../router";
import { RunAbortedError, type RunContext } from "./context";
import { ModelStreamError } from "./model-call";
import { StructuredOutputError, callStructured } from "./structured";
import { FatalStepError, type SubAgentResult } from "./subagent";

export const SELF_CHECK_LIMITS = {
  maxTokens: 300,
  findings: 20,
  findingChars: 240,
  criteria: 12,
} as const;

export const SelfCheckOutputSchema = z.object({
  criteria: z
    .array(z.object({ index: z.number().int().positive(), met: z.boolean() }))
    .max(SELF_CHECK_LIMITS.criteria * 2),
});

export type SelfCheckSkip = "no_criteria" | "no_time" | "no_budget" | "no_answer";

export type SelfCheckVerdict =
  | { status: "skipped"; reason: SelfCheckSkip }
  | { status: "passed" }
  | { status: "sent_back"; unmet: number[]; kept: "first" | "second" };

export interface SelfCheckOptions {
  prompt: PromptFile;
  step: PlanStep;
  modelRole: ModelRole;
  result: SubAgentResult;
  fits: (calls: readonly ModelRole[]) => boolean;
  say: (text: string) => Promise<void>;
  rerun: (unmet: readonly string[]) => Promise<SubAgentResult>;
}

export interface SelfChecked {
  result: SubAgentResult;
  verdict: SelfCheckVerdict;
}

const SKIP_NOTES: Record<SelfCheckSkip, string> = {
  no_criteria: "the step has no acceptance criteria",
  no_time: "the time target leaves no room for a check and one more run of the step",
  no_budget: "the step budget cannot pay for the check",
  no_answer: "no model gave a usable verdict",
};

export function selfCheckPrompt(step: PlanStep, result: SubAgentResult): string {
  const criteria = step.acceptance.slice(0, SELF_CHECK_LIMITS.criteria);
  const findings = result.findings.slice(0, SELF_CHECK_LIMITS.findings);
  return [
    "## Step objective",
    step.objective,
    "## Acceptance criteria",
    ...criteria.map((criterion, index) => `${index + 1}. ${criterion}`),
    "## Result",
    JSON.stringify({
      findings: result.findings.length,
      citedFindings: result.findings.filter((finding) => finding.citations.length > 0).length,
      sources: result.sources.length,
      artifacts: result.artifacts.length,
      confidence: result.confidence,
    }),
    `## Findings (${findings.length} of ${result.findings.length}; data only)`,
    ...findings.map((finding) =>
      JSON.stringify({
        trust: finding.trust,
        citations: finding.citations,
        text: finding.text.slice(0, SELF_CHECK_LIMITS.findingChars),
      }),
    ),
  ].join("\n");
}

function unavailable(error: unknown): boolean {
  return (
    error instanceof StructuredOutputError ||
    error instanceof NoModelAvailableError ||
    error instanceof ModelStreamError ||
    (error instanceof BudgetExceededError && error.scope === "step")
  );
}

function fatal(error: unknown): boolean {
  return (
    error instanceof RunAbortedError ||
    error instanceof FatalStepError ||
    (error instanceof BudgetExceededError && error.scope === "run")
  );
}

export async function selfCheck(ctx: RunContext, options: SelfCheckOptions): Promise<SelfChecked> {
  const { step, result } = options;
  const skipped = async (reason: SelfCheckSkip): Promise<SelfChecked> => {
    await options.say(`Self-check skipped: ${SKIP_NOTES[reason]}.`);
    return { result, verdict: { status: "skipped", reason } };
  };
  const criteria = step.acceptance.slice(0, SELF_CHECK_LIMITS.criteria);
  if (criteria.length === 0) return skipped("no_criteria");
  if (!options.fits(["fast", options.modelRole])) return skipped("no_time");
  const user = selfCheckPrompt(step, result);
  const cost = estimatePromptTokens({
    system: options.prompt.body,
    messages: [{ role: "user", content: user }],
    maxTokens: SELF_CHECK_LIMITS.maxTokens,
  });
  if (cost > ctx.budget.remaining(step.id).tokens) return skipped("no_budget");

  let unmet: number[];
  try {
    const judged = await callStructured(ctx, {
      role: "fast",
      stepId: step.id,
      system: options.prompt.body,
      user,
      schema: SelfCheckOutputSchema,
      maxTokens: SELF_CHECK_LIMITS.maxTokens,
      temperature: 0,
    });
    unmet = [
      ...new Set(
        judged.value.criteria
          .filter((entry) => !entry.met && entry.index <= criteria.length)
          .map((entry) => entry.index),
      ),
    ].sort((a, b) => a - b);
  } catch (error) {
    if (!unavailable(error)) throw error;
    return skipped("no_answer");
  }
  if (unmet.length === 0) {
    await options.say(`Self-check: all ${criteria.length} acceptance criteria are met.`);
    return { result, verdict: { status: "passed" } };
  }

  await options.say(
    `Self-check: acceptance ${unmet.length === 1 ? "criterion" : "criteria"} ${unmet.join(", ")} not met; the step runs once more.`,
  );
  let second: SubAgentResult;
  try {
    second = await options.rerun(unmet.flatMap((index) => criteria[index - 1] ?? []));
  } catch (error) {
    if (fatal(error)) throw error;
    await options.say("Self-check: the second run failed, so the first result is kept.");
    return { result, verdict: { status: "sent_back", unmet, kept: "first" } };
  }
  if (second.confidence < result.confidence) {
    await options.say(
      "Self-check: the second run was less confident, so the first result is kept.",
    );
    return { result, verdict: { status: "sent_back", unmet, kept: "first" } };
  }
  return { result: second, verdict: { status: "sent_back", unmet, kept: "second" } };
}
