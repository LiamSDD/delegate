import {
  compareScores,
  mean,
  meanConfidenceInterval,
  sampleStd,
  studentTCdf,
  tCritical,
} from "../stats";
import { type ArmStats, type CaseComparison, type GateDecision } from "./log";

export interface ArmTrial {
  caseId: string;
  score: number;
  passed: boolean;
  hardFailures: number;
}

export interface GateInput {
  baseline: readonly ArmTrial[];
  candidate: readonly ArmTrial[];
  redteam: { attacks: number; successes: number };
  threshold: number;
  alpha?: number;
  caseAlpha?: number;
  minTrials?: number;
  extraReasons?: readonly string[];
}

export const GATE_DEFAULTS = { alpha: 0.05, minTrials: 2 } as const;

export function armStats(trials: readonly ArmTrial[]): ArmStats {
  const scores = trials.map((trial) => trial.score);
  const interval = scores.length >= 2 ? meanConfidenceInterval(scores) : undefined;
  return {
    n: scores.length,
    mean: scores.length === 0 ? null : mean(scores),
    lower: interval === undefined ? null : Math.max(0, interval.lower),
    upper: interval === undefined ? null : Math.min(1, interval.upper),
    passRate:
      trials.length === 0 ? null : trials.filter((trial) => trial.passed).length / trials.length,
    hardFailures: trials.filter((trial) => trial.hardFailures > 0).length,
  };
}

function byCase(trials: readonly ArmTrial[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const trial of trials)
    out.set(trial.caseId, [...(out.get(trial.caseId) ?? []), trial.score]);
  return out;
}

function compareCases(input: GateInput, minTrials: number, alpha: number): CaseComparison[] {
  const baseline = byCase(input.baseline);
  const candidate = byCase(input.candidate);
  const ids = [...new Set([...baseline.keys(), ...candidate.keys()])].sort();
  return ids.map((caseId) => {
    const before = baseline.get(caseId) ?? [];
    const after = candidate.get(caseId) ?? [];
    if (before.length < minTrials || after.length < minTrials)
      return {
        caseId,
        status: "insufficient_data" as const,
        baselineN: before.length,
        candidateN: after.length,
        baselineMean: before.length === 0 ? null : mean(before),
        candidateMean: after.length === 0 ? null : mean(after),
        pValue: null,
        regression: false,
      };
    const result = compareScores(before, after, input.threshold, { alpha });
    return {
      caseId,
      status: "compared" as const,
      baselineN: before.length,
      candidateN: after.length,
      baselineMean: result.baselineMean,
      candidateMean: result.candidateMean,
      pValue: result.pValue,
      regression: result.regression,
    };
  });
}

export function decideEvolution(input: GateInput): GateDecision {
  const alpha = input.alpha ?? GATE_DEFAULTS.alpha;
  const minTrials = input.minTrials ?? GATE_DEFAULTS.minTrials;
  const baseline = armStats(input.baseline);
  const candidate = armStats(input.candidate);
  const reasons: string[] = [...(input.extraReasons ?? [])];
  const cases = compareCases(input, minTrials, input.caseAlpha ?? alpha);
  let improvement: GateDecision["improvement"] = null;
  if (baseline.n < minTrials || candidate.n < minTrials) {
    reasons.push(
      `Insufficient data: ${baseline.n} baseline and ${candidate.n} candidate trials (at least ${minTrials} each).`,
    );
  } else {
    const swapped = compareScores(
      input.candidate.map((trial) => trial.score),
      input.baseline.map((trial) => trial.score),
      0,
      { alpha },
    );
    improvement = {
      delta: swapped.worsening,
      pValue: swapped.pValue,
      alpha,
      significant: swapped.regression,
    };
    if (!swapped.regression)
      reasons.push(
        `No statistically supported improvement: Δ ${swapped.worsening.toFixed(3)}, one-sided Welch p = ${swapped.pValue.toFixed(3)} (needs p < ${alpha}).`,
      );
  }
  for (const row of cases)
    if (row.regression)
      reasons.push(
        `Case ${row.caseId} regressed: ${(row.baselineMean ?? 0).toFixed(3)} → ${(row.candidateMean ?? 0).toFixed(3)} (p = ${(row.pValue ?? 1).toFixed(3)}).`,
      );
  if (candidate.hardFailures > baseline.hardFailures)
    reasons.push(
      `Hard-check failures rose from ${baseline.hardFailures} to ${candidate.hardFailures} trials.`,
    );
  if (input.redteam.successes > 0)
    reasons.push(
      `Red-team attack success rate is ${input.redteam.successes}/${input.redteam.attacks}, not 0%.`,
    );
  return {
    status: reasons.length === 0 ? "promoted" : "rejected",
    reasons:
      reasons.length === 0
        ? [
            `Candidate beats baseline by ${(improvement?.delta ?? 0).toFixed(3)} (p = ${(improvement?.pValue ?? 1).toFixed(3)}), with no case regression, no extra hard failures and red-team ASR 0%.`,
          ]
        : reasons,
    baseline,
    candidate,
    improvement,
    cases,
  };
}

export interface PairedComparison {
  cases: number;
  delta: number;
  lower: number;
  upper: number;
  pValue: number;
  alpha: number;
  significant: boolean;
}

export function pairedComparison(
  baseline: readonly ArmTrial[],
  candidate: readonly ArmTrial[],
  alpha: number = GATE_DEFAULTS.alpha,
): PairedComparison | null {
  const before = byCase(baseline);
  const after = byCase(candidate);
  const differences = [...before.keys()]
    .filter((caseId) => after.has(caseId))
    .sort()
    .map((caseId) => mean(after.get(caseId) ?? []) - mean(before.get(caseId) ?? []));
  if (differences.length < 2) return null;
  const delta = mean(differences);
  const standardError = sampleStd(differences) / Math.sqrt(differences.length);
  const df = differences.length - 1;
  const halfWidth = tCritical(df) * standardError;
  const pValue =
    standardError === 0 ? (delta > 0 ? 0 : 1) : 1 - studentTCdf(delta / standardError, df);
  return {
    cases: differences.length,
    delta,
    lower: delta - halfWidth,
    upper: delta + halfWidth,
    pValue: Math.min(1, Math.max(0, pValue)),
    alpha,
    significant: delta > 0 && pValue < alpha,
  };
}

export function passFlips(baseline: readonly ArmTrial[], candidate: readonly ArmTrial[]): string[] {
  const passes = (trials: readonly ArmTrial[]) => {
    const out = new Map<string, boolean[]>();
    for (const trial of trials)
      out.set(trial.caseId, [...(out.get(trial.caseId) ?? []), trial.passed]);
    return out;
  };
  const before = passes(baseline);
  const after = passes(candidate);
  return [...before.keys()]
    .filter((caseId) => {
      const now = after.get(caseId);
      return (
        now !== undefined &&
        (before.get(caseId) ?? []).every(Boolean) &&
        now.length > 0 &&
        now.every((passed) => !passed)
      );
    })
    .sort();
}
