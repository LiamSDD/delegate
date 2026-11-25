import { type RunEvent } from "@delegate/runtime";
import {
  type MissionId,
  type RunMissionOptions,
  type RuntimePrompts,
} from "@delegate/runtime/server";
import { type z } from "zod";

import { type DatasetRef } from "../datasets/jsonl";
import { type LinkStatus } from "../graders/xray";
import {
  type BudgetTargets,
  type GradedCheck,
  type RunMetrics,
  type RunOutcome,
  type ServingRecord,
} from "../graders/run-metrics";
import { type Check } from "../types";

export const EVAL_MISSIONS = ["xray", "audit", "build", "repo", "goal"] as const;
export type EvalMission = (typeof EVAL_MISSIONS)[number];

export interface BaseCase {
  id: string;
  tags: string[];
  checks?: readonly Check[];
}

export interface MissionGrade {
  outcome: RunOutcome;
  failureCode?: string;
  checks: GradedCheck[];
  hardFailures: string[];
  metrics: RunMetrics;
  missionMetrics: Record<string, number>;
  serving: ServingRecord[];
  deliverable: unknown;
  citationsVerified: boolean | null;
}

export interface MissionGradeInput<C, X> {
  evalCase: C;
  events: readonly RunEvent[];
  targets: BudgetTargets;
  links?: ReadonlyMap<string, LinkStatus>;
  extras?: X;
}

export interface JudgeSpec<C, X> {
  promptFile: string;
  criteria: readonly string[];
  schema: z.ZodType<Record<string, unknown>>;
  render(evalCase: C, deliverable: unknown, extras: X | undefined): string;
  ready(grade: MissionGrade): boolean;
}

export interface QuestionAnswer {
  question: string;
  answer: string;
  refused: boolean;
  refusal?: string;
  citations: { url: string; title?: string; quote?: string }[];
  servedBy?: { provider: string; model: string };
}

export interface ExtrasContext<C> {
  evalCase: C;
  events: readonly RunEvent[];
  env: Record<string, string | undefined>;
  audience: "public-demo" | "owner";
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  answer?: (request: AnswerRequest) => Promise<QuestionAnswer>;
  log: (line: string) => void;
}

export interface AnswerRequest {
  assistantId: string;
  question: string;
  env: Record<string, string | undefined>;
  audience: "public-demo" | "owner";
  stores: TrialStores;
}

export type TrialStores = Pick<RunMissionOptions, "knowledge" | "assistants">;

export interface ExtrasSpec<C, X> {
  file: string;
  schema: z.ZodType<X>;
  stores(): TrialStores;
  collect(context: ExtrasContext<C>, stores: TrialStores): Promise<X>;
}

export interface MissionAdapter<C extends BaseCase = BaseCase, X = unknown> {
  mission: EvalMission;
  title: string;
  runtimeMissionId: MissionId;
  dataset: DatasetRef;
  loadCases(path?: string): C[];
  subject(evalCase: C): string;
  input(evalCase: C): Record<string, unknown>;
  runtimePrompts: readonly (keyof RuntimePrompts)[];
  defaultTargets: BudgetTargets;
  hardDeadlineMs?: number;
  citedUrls(events: readonly RunEvent[]): string[];
  grade(input: MissionGradeInput<C, X>): MissionGrade;
  judge: JudgeSpec<C, X>;
  extras?: ExtrasSpec<C, X>;
}

export function targetsFor(evalCase: BaseCase, base: BudgetTargets): BudgetTargets {
  const targets = { ...base };
  for (const check of evalCase.checks ?? []) {
    if (check.kind === "max_latency_ms") targets.maxLatencyMs = check.max;
    if (check.kind === "max_cost_micro_usd") targets.maxCostMicroUsd = check.max;
  }
  return targets;
}

export function linkCheck(
  urls: readonly string[],
  links: ReadonlyMap<string, LinkStatus> | undefined,
): GradedCheck {
  if (links === undefined)
    return {
      kind: "no_dead_links",
      severity: "soft",
      passed: true,
      skipped: true,
      detail: "skipped (offline)",
    };
  const dead = urls.filter((url) => links.get(url)?.ok === false);
  return {
    kind: "no_dead_links",
    severity: "soft",
    passed: dead.length === 0,
    detail: `${urls.length - dead.length}/${urls.length} cited URLs reachable${dead.length === 0 ? "" : `; dead: ${dead.slice(0, 3).join(", ")}`}`,
  };
}

export function runCompletedCheck(outcome: RunOutcome, failureCode?: string): GradedCheck {
  return {
    kind: "run_completed",
    severity: "hard",
    passed: outcome === "completed",
    ...(outcome === "completed"
      ? {}
      : { detail: `run failed: ${failureCode ?? "no terminal event"}` }),
  };
}
