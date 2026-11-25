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
import { type EvalDigest } from "./arm";
import { type EvolutionKind } from "./log";

export const PROPOSER_PROMPT_FILE = "evolve.proposer.v2.md";
export const PROPOSER_LIMITS = { addendumChars: 1_200, lines: 8, maxTokens: 1_500 } as const;

export function loadProposerPrompt(): PromptFile {
  return parsePromptFile(
    PROPOSER_PROMPT_FILE,
    readFileSync(new URL(`../../prompts/${PROPOSER_PROMPT_FILE}`, import.meta.url), "utf8"),
  );
}

const rationale = z.string().trim().min(1).max(600);

const addendum = z
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
  });

export function promptProposalSchema(targets: readonly PromptFile[]) {
  const names = new Set(targets.map((target) => target.name));
  const only = targets.length === 1 ? targets[0]?.name : undefined;
  return z.object({
    rationale,
    target: (only === undefined ? z.string() : z.string().default(only)).refine(
      (name) => names.has(name),
      { error: `target must be one of ${[...names].join(", ")}` },
    ),
    addendum,
  });
}
export interface PromptProposal {
  rationale: string;
  target: string;
  addendum: string;
}

export function playbookProposalSchema(pools: readonly Playbook[]) {
  const keys = new Set(pools.map((pool) => pool.key));
  const only = pools.length === 1 ? pools[0]?.key : undefined;
  return z
    .object({
      rationale,
      key: (only === undefined ? z.string() : z.string().default(only)).refine(
        (key) => keys.has(key),
        { error: `key must be one of ${[...keys].join(", ")}` },
      ),
      keep: z.array(z.string()).min(1).max(PLAYBOOK_LIMITS.entries),
    })
    .superRefine((value, ctx) => {
      const ids = new Set(
        pools.find((pool) => pool.key === value.key)?.entries.map((entry) => entry.id) ?? [],
      );
      if (value.keep.some((id) => !ids.has(id)))
        ctx.addIssue({ code: "custom", message: "Unknown playbook entry id", path: ["keep"] });
    });
}
export interface PlaybookProposal {
  rationale: string;
  key: string;
  keep: string[];
}

export type Proposal =
  | ({ kind: "prompt"; proposer: { provider: string; model: string } } & PromptProposal)
  | ({ kind: "playbook"; proposer: { provider: string; model: string } } & PlaybookProposal);

export const StoredProposalSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("prompt"),
    proposer: z.strictObject({ provider: z.string(), model: z.string() }),
    rationale: z.string(),
    target: z.string().min(1),
    addendum: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("playbook"),
    proposer: z.strictObject({ provider: z.string(), model: z.string() }),
    rationale: z.string(),
    key: z.string().min(1),
    keep: z.array(z.string().min(1)).min(1),
  }),
]);

export class ProposalError extends Error {
  override readonly name = "ProposalError";
}

function digestPlaybook(pool: Playbook): unknown {
  return {
    key: pool.key,
    entries: pool.entries.map((entry) => ({
      id: entry.id,
      polarity: entry.polarity,
      text: entry.text,
      evidence: entry.evidence,
      score: Math.round(entryScore(entry).mean * 1000) / 1000,
    })),
  };
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

export interface ProposalInput {
  kind: EvolutionKind;
  prompt: PromptFile;
  mission: { id: string; title: string };
  targets: readonly PromptFile[];
  digest: EvalDigest;
  pools: readonly Playbook[];
}

export async function proposeRevision(
  completer: JudgeCompleter,
  input: ProposalInput,
): Promise<Proposal> {
  const pools = input.pools.filter((pool) => pool.entries.length > 0);
  if (input.kind === "playbook" && pools.length === 0)
    throw new ProposalError("The baseline runs produced no playbook entries to choose from");
  if (input.kind === "prompt" && input.targets.length === 0)
    throw new ProposalError("This mission has no prompt a candidate may change");
  const user = JSON.stringify({
    kind: input.kind,
    mission: input.mission,
    prompts: input.targets.map((target) => ({
      name: target.name,
      version: target.version,
      intent: target.intent,
      body: target.body,
    })),
    eval: input.digest,
    playbooks: pools.map(digestPlaybook),
  });
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
    const proposer = { provider: reply.provider, model: reply.model };
    const json = extractJson(reply.text);
    if (input.kind === "prompt") {
      const parsed = promptProposalSchema(input.targets).safeParse(json);
      if (parsed.success) return { kind: "prompt", proposer, ...parsed.data };
      lastIssues = parsed.error.issues.map((issue) => issue.message).join("; ");
    } else {
      const parsed = playbookProposalSchema(pools).safeParse(json);
      if (parsed.success) return { kind: "playbook", proposer, ...parsed.data };
      lastIssues = parsed.error.issues.map((issue) => issue.message).join("; ");
    }
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
    ...(prompt.changes === undefined ? [] : [`changes: ${prompt.changes}`]),
    "---",
    prompt.body,
  ].join("\n");
}

export function candidatePrompt(
  parent: PromptFile,
  proposal: Pick<PromptProposal, "addendum">,
  lineageId: string,
  version: number,
): PromptFile {
  const body = [
    parent.body.trimEnd(),
    "",
    `## Learned rules (${lineageId}, from ${parent.name}@${parent.version})`,
    "",
    proposal.addendum.trim(),
    "",
  ].join("\n");
  const draft: PromptFile = {
    ...parent,
    version,
    status: "active",
    changes: `Eval-gated addendum ${lineageId} on top of v${parent.version}.`,
    body,
  };
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
