import { z } from "zod";

import { CaseComparisonSchema, EvolutionKindSchema } from "../evolve/log";
import { EVAL_MISSIONS } from "../results";

export const TRAINING_RECORD_VERSION = 1;

const count = z.number().int().nonnegative();
const unit = z.number().min(0).max(1);
const versions = z.record(z.string().min(1), count);

export const TrainingServingSchema = z.strictObject({
  role: z.enum(["planner", "worker", "fast"]),
  provider: z.string().min(1),
  model: z.string().min(1),
  calls: z.number().int().positive(),
});
export type TrainingServing = z.infer<typeof TrainingServingSchema>;

export const ArmReportSchema = z.strictObject({
  fingerprint: z.string().regex(/^[0-9a-f]{16}$/),
  source: z.enum(["run", "cache", "result"]),
  evalRun: z.string().min(1),
  trials: count,
  graded: count,
  errored: count,
  score: z.strictObject({
    mean: unit.nullable(),
    lower: unit.nullable(),
    upper: unit.nullable(),
    n: count,
  }),
  passRate: z.strictObject({ rate: unit, lower: unit, upper: unit, n: count }).nullable(),
  hardFailures: count,
  tokens: count,
  wallMs: count,
  models: z.array(TrainingServingSchema),
});
export type ArmReport = z.infer<typeof ArmReportSchema>;

export const TrainingVersionsSchema = z.strictObject({ prompts: versions, playbooks: versions });
export type TrainingVersions = z.infer<typeof TrainingVersionsSchema>;

export const TrainingDecisionStatusSchema = z.enum(["promoted", "rejected", "inconclusive"]);
export type TrainingDecisionStatus = z.infer<typeof TrainingDecisionStatusSchema>;

export const TrainingRecordSchema = z.strictObject({
  version: z.literal(TRAINING_RECORD_VERSION),
  id: z.string().min(1),
  mission: z.enum(EVAL_MISSIONS),
  round: z.number().int().positive(),
  kind: EvolutionKindSchema,
  startedAt: z.iso.datetime({ offset: true }),
  finishedAt: z.iso.datetime({ offset: true }),
  wallMs: count,
  dataset: z.strictObject({ name: z.string().min(1), version: z.number().int().positive() }),
  cases: z.array(z.string().min(1)),
  trialsPerCase: z.number().int().positive(),
  parent: TrainingVersionsSchema,
  child: TrainingVersionsSchema,
  change: z.strictObject({
    prompt: z
      .strictObject({
        key: z.string().min(1),
        name: z.string().min(1),
        from: z.number().int().positive(),
        to: z.number().int().positive(),
      })
      .nullable(),
    playbook: z
      .strictObject({ key: z.string().min(1), from: count, to: count, entries: count })
      .nullable(),
  }),
  proposal: z.strictObject({
    rationale: z.string(),
    addendum: z.string().optional(),
    keep: z.array(z.string()).optional(),
    proposer: z.strictObject({ provider: z.string(), model: z.string() }).nullable(),
    error: z.string().optional(),
  }),
  arms: z.strictObject({ baseline: ArmReportSchema, candidate: ArmReportSchema.nullable() }),
  comparison: z.strictObject({
    alpha: z.number().min(0).max(1),
    comparisons: z.number().int().positive(),
    welch: z.strictObject({ delta: z.number(), pValue: unit, significant: z.boolean() }).nullable(),
    paired: z
      .strictObject({
        cases: z.number().int().positive(),
        delta: z.number(),
        lower: z.number(),
        upper: z.number(),
        pValue: unit,
        significant: z.boolean(),
      })
      .nullable(),
    cases: z.array(CaseComparisonSchema),
  }),
  redteam: z
    .strictObject({ suite: z.string(), attacks: count, successes: count, asr: unit })
    .nullable(),
  decision: z.strictObject({
    status: TrainingDecisionStatusSchema,
    reasons: z.array(z.string().min(1)).min(1),
  }),
  promotion: z.strictObject({ file: z.string().min(1), apply: z.string().optional() }).nullable(),
  tokens: count,
  models: z.array(TrainingServingSchema),
});
export type TrainingRecord = z.infer<typeof TrainingRecordSchema>;

export { MISSION_TARGETS, SHARED_PROMPTS, type MissionTargets } from "../evolve/targets";
