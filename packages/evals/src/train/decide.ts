import {
  armTrialsOf,
  gradedRows,
  newHardFailures,
  servingMismatches,
  type ArmRow,
  type ArmServing,
} from "../evolve/arm";
import { GATE_DEFAULTS, decideEvolution, pairedComparison, passFlips } from "../evolve/gate";
import { type TrainingRecord } from "./record";

export interface StepArm {
  rows: readonly ArmRow[];
  models: readonly ArmServing[];
  problems: readonly string[];
}

export interface StepDecisionInput {
  baseline: StepArm;
  candidate: StepArm | null;
  redteam: { attacks: number; successes: number } | null;
  threshold: number;
  comparisons: number;
  alpha?: number;
  noCandidateReason?: string;
}

export interface StepDecision {
  decision: TrainingRecord["decision"];
  comparison: TrainingRecord["comparison"];
}

function fixed(value: number): string {
  return value.toFixed(3);
}

export function decideStep(input: StepDecisionInput): StepDecision {
  const baseAlpha = input.alpha ?? GATE_DEFAULTS.alpha;
  const comparisons = Math.max(1, input.comparisons);
  const alpha = baseAlpha / comparisons;
  const empty = { alpha, comparisons, welch: null, paired: null, cases: [] };
  const problems = [
    ...input.baseline.problems.map((problem) => `Baseline arm: ${problem}.`),
    ...(input.candidate?.problems ?? []).map((problem) => `Candidate arm: ${problem}.`),
  ];
  if (problems.length > 0)
    return {
      decision: {
        status: "inconclusive",
        reasons: [
          ...problems,
          "The comparison would not be fair, so nothing was promoted and the arm is not kept.",
        ],
      },
      comparison: empty,
    };
  if (input.candidate === null || input.redteam === null)
    return {
      decision: {
        status: "rejected",
        reasons: [
          `No candidate was evaluated: ${input.noCandidateReason ?? "no proposal was made"}`,
        ],
      },
      comparison: empty,
    };

  const baselineRows = gradedRows(input.baseline.rows);
  const candidateRows = gradedRows(input.candidate.rows);
  const baseline = armTrialsOf(baselineRows);
  const candidate = armTrialsOf(candidateRows);
  const paired = pairedComparison(baseline, candidate, alpha);
  const extra: string[] = [];
  if (paired !== null && !paired.significant)
    extra.push(
      `No paired improvement: mean per-case difference ${fixed(paired.delta)} [${fixed(paired.lower)}, ${fixed(paired.upper)}] over ${paired.cases} cases, one-sided p = ${fixed(paired.pValue)} (needs p < ${fixed(alpha)}).`,
    );
  for (const caseId of passFlips(baseline, candidate))
    extra.push(`Case ${caseId} passed every baseline trial and failed every candidate trial.`);
  const fresh = newHardFailures(baselineRows, candidateRows);
  if (fresh.length > 0)
    extra.push(`New hard failures that the baseline did not have: ${fresh.join("; ")}.`);
  const mismatches = servingMismatches(input.baseline.models, input.candidate.models);
  if (mismatches.length > 0)
    extra.push(
      `The arms were served by different models, so the difference cannot be attributed to the change (${mismatches.join("; ")}).`,
    );
  const gate = decideEvolution({
    baseline,
    candidate,
    redteam: input.redteam,
    threshold: input.threshold,
    alpha,
    caseAlpha: baseAlpha,
    extraReasons: extra,
  });
  const reasons =
    gate.status === "promoted" && paired !== null
      ? [
          ...gate.reasons,
          `Paired over ${paired.cases} cases: mean per-case difference ${fixed(paired.delta)} [${fixed(paired.lower)}, ${fixed(paired.upper)}], one-sided p = ${fixed(paired.pValue)}.`,
        ]
      : gate.reasons;
  return {
    decision: { status: gate.status, reasons },
    comparison: {
      alpha,
      comparisons,
      welch:
        gate.improvement === null
          ? null
          : {
              delta: gate.improvement.delta,
              pValue: gate.improvement.pValue,
              significant: gate.improvement.significant,
            },
      paired:
        paired === null
          ? null
          : {
              cases: paired.cases,
              delta: paired.delta,
              lower: paired.lower,
              upper: paired.upper,
              pValue: paired.pValue,
              significant: paired.significant,
            },
      cases: gate.cases,
    },
  };
}
