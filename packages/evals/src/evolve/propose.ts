import { readFileSync } from "node:fs";

import {
  PLAYBOOK_LIMITS,
  PlaybookSchema,
  entryScore,
  parsePromptFile,
  redactPii,
  safeLessonText,
  type Playbook,
  type PromptFile,
} from "@delegate/runtime";
import { detectInjection } from "@delegate/runtime/security";
import { z } from "zod";

import { type JudgeCompleter } from "../judge/xray-judge";
import { type EvalSummary } from "../runner";
import { type EvolutionKind } from "./log";

export const PROPOSER_PROMPT_FILE = "evolve.proposer.v1.md";
export const PROPOSER_LIMITS = { addendumChars: 1_200, lines: 8, maxTokens: 1_500 } as const;

export function loadProposerPrompt(): PromptFile {
  return parsePromptFile(
    PROPOSER_PROMPT_FILE,
    readFileSync(new URL(`../../prompts/${PROPOSER_PROMPT_FILE}`, import.meta.url), "utf8"),
  );
}

const rationale = z.string().trim().min(1).max(600);

export const PromptProposalSchema = z.object({
  rationale,
  addendum: z
    .string()
    .trim()
    .min(1)
    .max(PROPOSER_LIMITS.addendumChars)
    .superRefine((text, ctx) => {
      const lines = text.split("\n").filter((line) => line.trim() !== "");
      if (lines.length > PROPOSER_LIMITS.lines)
        ctx.addIssue({ code: "custom", message: `At most ${PROPOSER_LIMITS.lines} lines` });
      if (lines.some((line) => !line.trim().startsWith("- ")))
        ctx.addIssue({ code: "custom", message: "Every line must be a bullet starting with '- '" });
      if (/https?:\/\/|www\./i.test(text))
        ctx.addIssue({ code: "custom", message: "The addendum must not contain URLs" });
      if (detectInjection(text) !== undefined)
        ctx.addIssue({ code: "custom", message: "The addendum reads like an injection" });
      if (redactPii(text).count > 0)
        ctx.addIssue({ code: "custom", message: "The addendum must not contain personal data" });
    }),
});
export type PromptProposal = z.infer<typeof PromptProposalSchema>;

export function playbookProposalSchema(pool: Playbook) {
  const ids = new Set(pool.entries.map((entry) => entry.id));
  return z.object({
    rationale,
    keep: z
      .array(z.string().refine((id) => ids.has(id), { error: "Unknown playbook entry id" }))
      .min(1)
      .max(PLAYBOOK_LIMITS.entries),
  });
}
export interface PlaybookProposal {
  rationale: string;
  keep: string[];
}

export type Proposal =
  | ({ kind: "prompt"; proposer: { provider: string; model: string } } & PromptProposal)
  | ({ kind: "playbook"; proposer: { provider: string; model: string } } & PlaybookProposal);

export class ProposalError extends Error {
  override readonly name = "ProposalError";
}

export function evalDigest(summary: EvalSummary): unknown {
  return {
    passRate: summary.overall.passRate,
    score: summary.overall.score,
    hardFailures: summary.overall.hardFailures,
    errored: summary.overall.errored,
    checkPassRates: summary.overall.checkPassRates,
    cases: summary.cases.map((row) => ({
      caseId: row.caseId,
      passRate: row.passRate.rate,
      score: row.score.mean,
      hardFailures: row.hardFailures,
      failureCodes: row.failureCodes,
    })),
  };
}

function digestPlaybook(pool: Playbook | null): unknown[] {
  return (pool?.entries ?? []).map((entry) => ({
    id: entry.id,
    polarity: entry.polarity,
    text: entry.text,
    evidence: entry.evidence,
    score: Math.round(entryScore(entry).mean * 1000) / 1000,
  }));
}

function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1] ?? text;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(fenced.slice(start, end + 1)) as unknown;
  } catch {
    return undefined;
  }
}

export async function proposeRevision(
  completer: JudgeCompleter,
  input: {
    kind: EvolutionKind;
    prompt: PromptFile;
    planner: PromptFile;
    summary: EvalSummary;
    pool: Playbook | null;
  },
): Promise<Proposal> {
  if (input.kind === "playbook" && (input.pool === null || input.pool.entries.length === 0))
    throw new ProposalError("The eval runs produced no playbook entries to choose from");
  const user = JSON.stringify({
    kind: input.kind,
    plannerPrompt: input.planner.body,
    eval: evalDigest(input.summary),
    playbook: digestPlaybook(input.pool),
  });
  const schema =
    input.kind === "prompt" || input.pool === null
      ? PromptProposalSchema
      : playbookProposalSchema(input.pool);
  const messages: { role: "user" | "assistant"; content: string }[] = [
    { role: "user", content: user },
  ];
  let lastIssues = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const reply = await completer.complete({
      system: input.prompt.body,
      messages,
      maxTokens: PROPOSER_LIMITS.maxTokens,
    });
    const parsed = schema.safeParse(extractJson(reply.text));
    const proposer = { provider: reply.provider, model: reply.model };
    if (parsed.success) {
      return "addendum" in parsed.data
        ? { kind: "prompt", proposer, ...parsed.data }
        : { kind: "playbook", proposer, ...parsed.data };
    }
    lastIssues = parsed.error.issues.map((issue) => issue.message).join("; ");
    messages.push(
      { role: "assistant", content: reply.text.slice(0, 4_000) },
      {
        role: "user",
        content: `That answer failed validation: ${lastIssues}. Return only the corrected JSON object.`,
      },
    );
  }
  throw new ProposalError(`The proposal failed validation twice: ${lastIssues}`);
}

export function renderPromptFile(prompt: PromptFile): string {
  return [
    "---",
    `name: ${prompt.name}`,
    `version: ${prompt.version}`,
    `status: ${prompt.status}`,
    `intent: ${prompt.intent}`,
    `inputs: [${prompt.inputs.join(", ")}]`,
    `output: ${prompt.output}`,
    "---",
    prompt.body,
  ].join("\n");
}

export function candidatePrompt(
  parent: PromptFile,
  proposal: PromptProposal,
  evolutionId: string,
  version: number,
): PromptFile {
  const body = [
    parent.body.trimEnd(),
    "",
    `## Learned planning rules (evolution ${evolutionId}, from ${parent.name}@${parent.version})`,
    "",
    proposal.addendum.trim(),
    "",
  ].join("\n");
  const draft: PromptFile = { ...parent, version, status: "active", body };
  const fileName = `${parent.name}.v${version}.md`;
  return parsePromptFile(fileName, renderPromptFile(draft));
}

export function candidatePlaybook(
  pool: Playbook,
  keep: readonly string[],
  parent: Playbook | null,
): Playbook {
  const chosen = new Set(keep);
  return PlaybookSchema.parse({
    ...pool,
    version: (parent?.version ?? 0) + 1,
    entries: pool.entries.filter(
      (entry) => chosen.has(entry.id) && safeLessonText(entry.text) === entry.text,
    ),
  });
}
