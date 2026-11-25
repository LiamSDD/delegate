import { z } from "zod";

export const EVOLUTION_LOG_VERSION = 1;

const nullableUnit = z.number().min(0).max(1).nullable();

export const ArmStatsSchema = z.strictObject({
  n: z.number().int().nonnegative(),
  mean: nullableUnit,
  lower: nullableUnit,
  upper: nullableUnit,
  passRate: nullableUnit,
  hardFailures: z.number().int().nonnegative(),
});
export type ArmStats = z.infer<typeof ArmStatsSchema>;

export const CaseComparisonSchema = z.strictObject({
  caseId: z.string().min(1),
  status: z.enum(["compared", "insufficient_data"]),
  baselineN: z.number().int().nonnegative(),
  candidateN: z.number().int().nonnegative(),
  baselineMean: nullableUnit,
  candidateMean: nullableUnit,
  pValue: z.number().min(0).max(1).nullable(),
  regression: z.boolean(),
});
export type CaseComparison = z.infer<typeof CaseComparisonSchema>;

export const GateDecisionSchema = z.strictObject({
  status: z.enum(["promoted", "rejected"]),
  reasons: z.array(z.string().min(1)).min(1),
  baseline: ArmStatsSchema,
  candidate: ArmStatsSchema,
  improvement: z
    .strictObject({
      delta: z.number(),
      pValue: z.number().min(0).max(1),
      alpha: z.number().min(0).max(1),
      significant: z.boolean(),
    })
    .nullable(),
  cases: z.array(CaseComparisonSchema),
});
export type GateDecision = z.infer<typeof GateDecisionSchema>;

const PromptRefSchema = z.strictObject({
  name: z.string().min(1),
  version: z.number().int().positive(),
});
const PlaybookRefSchema = z.strictObject({
  key: z.string().min(1),
  version: z.number().int().nonnegative(),
  entries: z.number().int().nonnegative(),
});

export const EvolutionKindSchema = z.enum(["prompt", "playbook"]);
export type EvolutionKind = z.infer<typeof EvolutionKindSchema>;

export const EvolutionLogSchema = z.strictObject({
  version: z.literal(EVOLUTION_LOG_VERSION),
  id: z.string().min(1),
  mission: z.literal("xray"),
  kind: EvolutionKindSchema,
  startedAt: z.iso.datetime({ offset: true }),
  finishedAt: z.iso.datetime({ offset: true }),
  trialsPerCase: z.number().int().positive(),
  cases: z.array(z.string().min(1)),
  parent: z.strictObject({ prompt: PromptRefSchema, playbook: PlaybookRefSchema }),
  child: z.strictObject({ prompt: PromptRefSchema, playbook: PlaybookRefSchema }),
  proposal: z.strictObject({
    rationale: z.string(),
    addendum: z.string().optional(),
    keep: z.array(z.string()).optional(),
    proposer: z.strictObject({ provider: z.string(), model: z.string() }).nullable(),
    error: z.string().optional(),
  }),
  evalRuns: z.strictObject({ baseline: z.string(), candidate: z.string().nullable() }),
  redteam: z.strictObject({
    suite: z.string(),
    attacks: z.number().int().nonnegative(),
    successes: z.number().int().nonnegative(),
    asr: z.number().min(0).max(1),
  }),
  decision: GateDecisionSchema,
  promotion: z
    .strictObject({
      file: z.string().min(1),
      apply: z.string().optional(),
    })
    .nullable(),
});
export type EvolutionLog = z.infer<typeof EvolutionLogSchema>;
