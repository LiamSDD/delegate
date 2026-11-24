import { z } from "zod";

import { meanConfidenceInterval, wilsonInterval } from "./stats";

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const microUsd = z.number().int().nonnegative();

export const ModelRoleSchema = z.enum(["planner", "worker", "fast"]);

export const CheckSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("schema_valid") }),
  z.strictObject({ kind: z.literal("min_citations"), min: z.number().int().nonnegative() }),
  z.strictObject({ kind: z.literal("no_dead_links") }),
  z.strictObject({ kind: z.literal("max_cost_micro_usd"), max: microUsd }),
  z.strictObject({ kind: z.literal("max_latency_ms"), max: z.number().int().positive() }),
  z.strictObject({ kind: z.literal("mentions"), terms: z.array(z.string().min(1)).min(1) }),
]);
export type Check = z.infer<typeof CheckSchema>;

export const EvalCaseSchema = z.strictObject({
  id: slug,
  mission: slug,
  version: z.number().int().positive(),
  input: z.record(z.string(), z.unknown()),
  checks: z.array(CheckSchema),
  rubric: z.array(z.string().min(1)),
  tags: z.array(slug),
  notes: z.string().optional(),
});
export type EvalCase = z.infer<typeof EvalCaseSchema>;

export const PromptVersionsSchema = z.record(slug, z.number().int().positive());
export type PromptVersions = z.infer<typeof PromptVersionsSchema>;

export const ServingSchema = z.strictObject({
  role: ModelRoleSchema,
  provider: z.string().min(1),
  model: z.string().min(1),
  calls: z.number().int().positive(),
});
export type Serving = z.infer<typeof ServingSchema>;

export const CheckResultSchema = z.strictObject({
  kind: z.string().min(1),
  passed: z.boolean(),
  detail: z.string().optional(),
});

export const TrialSchema = z.strictObject({
  caseId: slug,
  mission: slug,
  trialIndex: z.number().int().nonnegative(),
  runId: z.string().min(1).optional(),
  promptVersions: PromptVersionsSchema,
  serving: z.array(ServingSchema).min(1),
  startedAt: z.iso.datetime({ offset: true }),
  latencyMs: z.number().int().nonnegative(),
  costMicroUsd: microUsd,
  score: z.number().min(0).max(1),
  passed: z.boolean(),
  checks: z.array(CheckResultSchema),
  judge: z
    .strictObject({
      provider: z.string().min(1),
      model: z.string().min(1),
      promptVersion: z.number().int().positive(),
      scores: z.record(z.string(), z.number().min(0).max(1)),
    })
    .optional(),
  error: z.string().optional(),
});
export type Trial = z.infer<typeof TrialSchema>;

export const ResultSchema = z.strictObject({
  caseId: slug,
  mission: slug,
  promptVersions: PromptVersionsSchema,
  trials: z.array(TrialSchema).min(2),
  score: z.strictObject({
    mean: z.number(),
    lower: z.number(),
    upper: z.number(),
    n: z.number().int(),
    confidence: z.number(),
  }),
  passRate: z.strictObject({
    rate: z.number(),
    lower: z.number(),
    upper: z.number(),
    n: z.number().int(),
    confidence: z.number(),
  }),
  meanCostMicroUsd: z.number().nonnegative(),
  p50LatencyMs: z.number().nonnegative(),
  serving: z.array(ServingSchema),
});
export type Result = z.infer<typeof ResultSchema>;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[middle - 1] ?? upper) + upper) / 2;
}

function sameVersions(a: PromptVersions, b: PromptVersions): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => a[key] === b[key]);
}

export function summariseTrials(input: readonly Trial[], confidence = 0.95): Result {
  const trials = input.map((trial) => TrialSchema.parse(trial));
  const [first] = trials;
  if (first === undefined || trials.length < 2)
    throw new RangeError("A result needs at least two trials");
  for (const trial of trials) {
    if (trial.caseId !== first.caseId || trial.mission !== first.mission) {
      throw new Error(
        `Cannot summarise trials from different cases: ${first.caseId} and ${trial.caseId}`,
      );
    }
    if (!sameVersions(trial.promptVersions, first.promptVersions)) {
      throw new Error(
        `Cannot summarise trials with different prompt versions for case ${first.caseId}`,
      );
    }
  }

  const ci = meanConfidenceInterval(
    trials.map((trial) => trial.score),
    confidence,
  );
  const passes = trials.filter((trial) => trial.passed).length;
  const serving = new Map<string, Serving>();
  for (const trial of trials) {
    for (const entry of trial.serving) {
      const key = `${entry.role}\u0000${entry.provider}\u0000${entry.model}`;
      const existing = serving.get(key);
      serving.set(
        key,
        existing === undefined
          ? { ...entry }
          : { ...existing, calls: existing.calls + entry.calls },
      );
    }
  }

  return {
    caseId: first.caseId,
    mission: first.mission,
    promptVersions: first.promptVersions,
    trials,
    score: { mean: ci.mean, lower: ci.lower, upper: ci.upper, n: ci.n, confidence: ci.confidence },
    passRate: wilsonInterval(passes, trials.length, confidence),
    meanCostMicroUsd: trials.reduce((sum, trial) => sum + trial.costMicroUsd, 0) / trials.length,
    p50LatencyMs: median(trials.map((trial) => trial.latencyMs)),
    serving: [...serving.values()].sort(
      (a, b) =>
        a.role.localeCompare(b.role) ||
        a.provider.localeCompare(b.provider) ||
        a.model.localeCompare(b.model),
    ),
  };
}
