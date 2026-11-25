import { type Playbook, type PlaybookStore } from "@delegate/runtime";
import { type RuntimePrompts } from "@delegate/runtime/server";
import { z } from "zod";

import { type EvalMission } from "../results";
import {
  runEval,
  type EvalSummary,
  type RunEvalDeps,
  type RunEvalOptions,
  type TrialRecord,
} from "../runner";
import { type ArmTrial } from "./gate";

export const ArmServingSchema = z.strictObject({
  role: z.enum(["planner", "worker", "fast"]),
  provider: z.string().min(1),
  model: z.string().min(1),
  calls: z.number().int().positive(),
});
export type ArmServing = z.infer<typeof ArmServingSchema>;

export const ArmRowSchema = z.strictObject({
  caseId: z.string().min(1),
  trial: z.number().int().nonnegative(),
  runId: z.string().min(1),
  outcome: z.enum(["completed", "failed", "errored"]),
  failureCode: z.string().min(1).optional(),
  passed: z.boolean(),
  score: z.number().min(0).max(1),
  hardFailures: z.array(z.string().min(1)),
  failedChecks: z.array(z.string().min(1)).optional(),
  tokens: z.number().int().nonnegative(),
  latencyMs: z.number().int().nonnegative(),
  serving: z.array(ArmServingSchema),
});
export type ArmRow = z.infer<typeof ArmRowSchema>;

export function rowFromTrial(record: TrialRecord): ArmRow {
  return {
    caseId: record.caseId,
    trial: record.trial,
    runId: record.runId,
    outcome: record.outcome,
    ...(record.failureCode === undefined ? {} : { failureCode: record.failureCode }),
    passed: record.passed,
    score: record.score,
    hardFailures: [...record.hardFailures],
    failedChecks: record.checks
      .filter((check) => check.skipped !== true && !check.passed)
      .map((check) => check.kind),
    tokens: record.metrics.totalTokens,
    latencyMs: record.metrics.latencyMs,
    serving: record.serving.map((entry) => ({ ...entry })),
  };
}

export function gradedRows(rows: readonly ArmRow[]): ArmRow[] {
  return rows.filter((row) => row.outcome !== "errored");
}

export function armTrialsOf(rows: readonly ArmRow[]): ArmTrial[] {
  return rows.map((row) => ({
    caseId: row.caseId,
    score: row.score,
    passed: row.passed,
    hardFailures: row.hardFailures.length,
  }));
}

export function mergeServing(lists: readonly (readonly ArmServing[])[]): ArmServing[] {
  const merged = new Map<string, ArmServing>();
  for (const entry of lists.flat()) {
    const key = `${entry.role}\u0000${entry.provider}\u0000${entry.model}`;
    const existing = merged.get(key);
    merged.set(
      key,
      existing === undefined ? { ...entry } : { ...existing, calls: existing.calls + entry.calls },
    );
  }
  return [...merged.values()].sort(
    (a, b) =>
      a.role.localeCompare(b.role) ||
      b.calls - a.calls ||
      a.provider.localeCompare(b.provider) ||
      a.model.localeCompare(b.model),
  );
}

export function dominantModels(serving: readonly ArmServing[]): Map<string, ArmServing> {
  const best = new Map<string, ArmServing>();
  for (const entry of mergeServing([serving])) {
    const current = best.get(entry.role);
    if (current === undefined || entry.calls > current.calls) best.set(entry.role, entry);
  }
  return best;
}

export function servingMismatches(
  baseline: readonly ArmServing[],
  candidate: readonly ArmServing[],
): string[] {
  const before = dominantModels(baseline);
  const after = dominantModels(candidate);
  const out: string[] = [];
  for (const [role, entry] of before) {
    const other = after.get(role);
    if (other === undefined) continue;
    if (other.provider !== entry.provider || other.model !== entry.model)
      out.push(
        `${role}: ${entry.provider}/${entry.model} served the baseline, ${other.provider}/${other.model} the candidate`,
      );
  }
  return out.sort();
}

export function newHardFailures(
  baseline: readonly ArmRow[],
  candidate: readonly ArmRow[],
): string[] {
  const kinds = (rows: readonly ArmRow[]) => {
    const out = new Map<string, Set<string>>();
    for (const row of rows) {
      const set = out.get(row.caseId) ?? new Set<string>();
      for (const kind of row.hardFailures) set.add(kind);
      out.set(row.caseId, set);
    }
    return out;
  };
  const before = kinds(baseline);
  const found: string[] = [];
  for (const [caseId, set] of kinds(candidate))
    for (const kind of set)
      if (before.get(caseId)?.has(kind) !== true) found.push(`${caseId}: ${kind}`);
  return found.sort();
}

export interface EvalDigest {
  trials: number;
  passRate: number | null;
  score: number | null;
  hardFailures: number;
  errored: number;
  failedChecks: Record<string, number>;
  cases: {
    caseId: string;
    passRate: number;
    score: number;
    hardFailures: string[];
    failureCodes: Record<string, number>;
  }[];
}

function tally(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of [...values].sort()) out[value] = (out[value] ?? 0) + 1;
  return out;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function digestRows(rows: readonly ArmRow[]): EvalDigest {
  const graded = gradedRows(rows);
  const caseIds = [...new Set(rows.map((row) => row.caseId))].sort();
  const average = (values: readonly number[]) =>
    values.length === 0 ? null : round3(values.reduce((sum, v) => sum + v, 0) / values.length);
  return {
    trials: rows.length,
    passRate: average(graded.map((row) => (row.passed ? 1 : 0))),
    score: average(graded.map((row) => row.score)),
    hardFailures: graded.filter((row) => row.hardFailures.length > 0).length,
    errored: rows.length - graded.length,
    failedChecks: tally(graded.flatMap((row) => row.failedChecks ?? row.hardFailures)),
    cases: caseIds.map((caseId) => {
      const own = rows.filter((row) => row.caseId === caseId);
      const ownGraded = gradedRows(own);
      return {
        caseId,
        passRate: average(ownGraded.map((row) => (row.passed ? 1 : 0))) ?? 0,
        score: average(ownGraded.map((row) => row.score)) ?? 0,
        hardFailures: [...new Set(ownGraded.flatMap((row) => row.hardFailures))].sort(),
        failureCodes: tally(
          own.flatMap((row) => (row.failureCode === undefined ? [] : [row.failureCode])),
        ),
      };
    }),
  };
}

export type Houses = Readonly<Record<string, Playbook | null>>;

export function readOnlyHouseStore(
  houses: Houses,
  sink: PlaybookStore | null = null,
): PlaybookStore {
  return {
    read: (key) => Promise.resolve({ workspace: null, house: houses[key] ?? null }),
    record: (run) => (sink === null ? Promise.resolve() : sink.record(run, { house: true })),
  };
}

export function hasHouse(houses: Houses): boolean {
  return Object.values(houses).some((house) => house !== null && house.entries.length > 0);
}

export interface LiveArm {
  mission: EvalMission;
  prompts: Partial<RuntimePrompts>;
  houses: Houses;
  store?: PlaybookStore;
  resultsDir: string;
}

export interface LiveArmResult {
  summary: EvalSummary;
  trials: TrialRecord[];
}

export function createLiveArmRunner(
  deps: RunEvalDeps,
  evalOptions: (mission: EvalMission, resultsDir: string) => RunEvalOptions,
): (arm: LiveArm) => Promise<LiveArmResult> {
  return async (arm) => {
    const trials: TrialRecord[] = [];
    const store = arm.store ?? (hasHouse(arm.houses) ? readOnlyHouseStore(arm.houses) : undefined);
    const options = evalOptions(arm.mission, arm.resultsDir);
    const summary = await runEval(
      {
        ...options,
        mission: arm.mission,
        resultsDir: arm.resultsDir,
        ...(Object.keys(arm.prompts).length === 0 ? {} : { prompts: arm.prompts }),
      },
      {
        ...deps,
        runMission: (runOptions) =>
          deps.runMission({
            ...runOptions,
            ...(store === undefined
              ? {}
              : {
                  playbooks: store,
                  houseLearning: true,
                  shippedHouse: (key: string) => arm.houses[key] ?? null,
                }),
          }),
        onTrial: (record) => trials.push(record),
      },
    );
    return { summary, trials };
  };
}
