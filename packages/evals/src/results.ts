import { z } from "zod";

import {
  InsufficientDataError,
  meanConfidenceInterval,
  wilsonInterval,
  type ProportionInterval,
} from "./stats";

export { wilsonInterval, type ProportionInterval } from "./stats";

export const EVAL_RESULT_FILE_VERSION = 1;

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const count = z.number().int().nonnegative();
const unit = z.number().min(0).max(1);

export const ResultModelSchema = z.strictObject({
  role: z.enum(["planner", "worker", "fast"]),
  provider: z.string().min(1),
  model: z.string().min(1),
  calls: z.number().int().positive(),
});

export const ResultJudgeModelSchema = z.strictObject({
  provider: z.string().min(1),
  model: z.string().min(1),
  calls: z.number().int().positive(),
});

export const ResultTrialSchema = z.strictObject({
  trial: count,
  runId: z.string().min(1),
  outcome: z.enum(["completed", "failed", "errored"]),
  failureCode: z.string().min(1).optional(),
  passed: z.boolean(),
  score: unit,
  citationsVerified: z.boolean().nullable(),
  judgeOverall: unit.nullable(),
  latencyMs: count,
  costMicroUsd: count,
  tokens: count,
});
export type ResultTrial = z.infer<typeof ResultTrialSchema>;

export const ResultCaseSchema = z.strictObject({
  caseId: slug,
  company: z.string().min(1),
  trials: z.array(ResultTrialSchema),
});

export const ResultCriterionAgreementSchema = z.strictObject({
  criterion: z.string().min(1),
  n: z.number().int().positive(),
  exactMatchRate: unit,
  withinOneRate: unit,
  kappa: z.number().min(-1).max(1).nullable(),
  kappaLower: z.number().min(-1).max(1).nullable(),
  kappaUpper: z.number().min(-1).max(1).nullable(),
});
export type ResultCriterionAgreement = z.infer<typeof ResultCriterionAgreementSchema>;

export const ResultAgreementSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("no_human_labels"), labels: z.literal(0) }),
  z.strictObject({
    status: z.literal("no_matching_judgements"),
    labels: z.number().int().positive(),
    matched: z.literal(0),
  }),
  z.strictObject({
    status: z.literal("ok"),
    labels: z.number().int().positive(),
    matched: z.number().int().positive(),
    criteria: z.array(ResultCriterionAgreementSchema),
  }),
]);
export type ResultAgreement = z.infer<typeof ResultAgreementSchema>;

export const EvalResultFileSchema = z.strictObject({
  version: z.literal(EVAL_RESULT_FILE_VERSION),
  id: z.string().min(1),
  mission: slug,
  mode: z.enum(["live", "replay"]),
  replayOf: z.string().min(1).optional(),
  dataset: z.strictObject({ name: z.string().min(1), version: z.number().int().positive() }),
  audience: z.string().min(1),
  startedAt: z.iso.datetime({ offset: true }),
  finishedAt: z.iso.datetime({ offset: true }),
  durationMs: count,
  trialsPerCase: z.number().int().positive(),
  promptVersions: z.record(z.string(), z.number().int().positive()),
  models: z.array(ResultModelSchema),
  judgeModels: z.array(ResultJudgeModelSchema),
  totals: z.strictObject({ trials: count, costMicroUsd: count, tokens: count }),
  cases: z.array(ResultCaseSchema),
  agreement: ResultAgreementSchema,
});
export type EvalResultFile = z.infer<typeof EvalResultFileSchema>;

export interface MeanInterval {
  mean: number;
  lower: number | null;
  upper: number | null;
  n: number;
}

export interface ResultScoreboard {
  trials: number;
  passRate: ProportionInterval | null;
  score: MeanInterval | null;
  judge: MeanInterval | null;
  citationAccuracy: ProportionInterval | null;
  p50LatencyMs: number | null;
  meanTokens: number | null;
  meanCostMicroUsd: number | null;
}

function proportion(successes: number, n: number): ProportionInterval | null {
  try {
    return wilsonInterval(successes, n);
  } catch (error) {
    if (error instanceof InsufficientDataError) return null;
    throw error;
  }
}

function meanInterval(values: readonly number[]): MeanInterval | null {
  if (values.length === 0) return null;
  if (values.length === 1) return { mean: values[0] ?? 0, lower: null, upper: null, n: 1 };
  const ci = meanConfidenceInterval(values);
  return { mean: ci.mean, lower: Math.max(0, ci.lower), upper: Math.min(1, ci.upper), n: ci.n };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[middle - 1] ?? upper) + upper) / 2;
}

function average(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function scoreboard(file: EvalResultFile): ResultScoreboard {
  const trials = file.cases.flatMap((entry) => entry.trials);
  const cited = trials.flatMap((trial) =>
    trial.citationsVerified === null ? [] : [trial.citationsVerified],
  );
  return {
    trials: trials.length,
    passRate: proportion(trials.filter((trial) => trial.passed).length, trials.length),
    score: meanInterval(trials.map((trial) => trial.score)),
    judge: meanInterval(
      trials.flatMap((trial) => (trial.judgeOverall === null ? [] : [trial.judgeOverall])),
    ),
    citationAccuracy: proportion(cited.filter(Boolean).length, cited.length),
    p50LatencyMs: median(trials.map((trial) => trial.latencyMs)),
    meanTokens: average(trials.map((trial) => trial.tokens)),
    meanCostMicroUsd: average(trials.map((trial) => trial.costMicroUsd)),
  };
}

export interface ParetoPoint {
  id: string;
  cost: number;
  quality: number;
}

export function paretoFrontier(points: readonly ParetoPoint[]): Set<string> {
  const frontier = new Set<string>();
  for (const point of points) {
    const dominated = points.some(
      (other) =>
        other.id !== point.id &&
        other.cost <= point.cost &&
        other.quality >= point.quality &&
        (other.cost < point.cost || other.quality > point.quality),
    );
    if (!dominated) frontier.add(point.id);
  }
  return frontier;
}
