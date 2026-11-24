import type { PlanStep, RunEvent } from "@delegate/runtime";

import { PlanStepsSchema } from "@/lib/m2-contract";

export type PlanEditResult = { ok: true; steps: PlanStep[] } | { ok: false; issues: string[] };

export function validatePlanEdit(proposed: readonly PlanStep[], edited: unknown): PlanEditResult {
  const parsed = PlanStepsSchema.safeParse(edited);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "steps"}: ${issue.message}`,
      ),
    };
  }
  const steps = parsed.data;
  const issues: string[] = [];
  if (steps.length === 0) issues.push("Keep at least one step.");
  const original = new Map(proposed.map((step) => [step.id, step]));
  const seen = new Set<string>();
  for (const step of steps) {
    const before = original.get(step.id);
    if (before === undefined) {
      issues.push(`Step ${step.id} is not in the proposed plan.`);
    } else {
      if (before.role !== step.role) issues.push(`Step ${step.id} cannot change role.`);
      for (const capability of step.capabilities) {
        if (!before.capabilities.includes(capability)) {
          issues.push(`Step ${step.id} cannot add capability ${capability}.`);
        }
      }
    }
    for (const input of step.inputs) {
      if (!seen.has(input) && steps.some((other) => other.id === input)) {
        issues.push(`Step ${step.id} runs before its input ${input}.`);
      }
    }
    seen.add(step.id);
  }
  return issues.length === 0 ? { ok: true, steps } : { ok: false, issues };
}

export interface DraftStep {
  step: PlanStep;
  enabled: boolean;
}

export function draftFromPlan(steps: readonly PlanStep[]): DraftStep[] {
  return steps.map((step) => ({ step, enabled: true }));
}

export function draftToSteps(draft: readonly DraftStep[]): PlanStep[] {
  return draft.filter((entry) => entry.enabled).map((entry) => entry.step);
}

export function moveStep(
  draft: readonly DraftStep[],
  stepId: string,
  delta: -1 | 1,
): DraftStep[] | null {
  const index = draft.findIndex((entry) => entry.step.id === stepId);
  const target = index + delta;
  const moving = draft[index];
  const neighbour = draft[target];
  if (moving === undefined || neighbour === undefined) return null;
  const first = delta === -1 ? neighbour : moving;
  const second = delta === -1 ? moving : neighbour;
  if (second.step.inputs.includes(first.step.id)) return null;
  const next = [...draft];
  next[index] = neighbour;
  next[target] = moving;
  return next;
}

export function draftIssues(proposed: readonly PlanStep[], draft: readonly DraftStep[]): string[] {
  const disabled = new Set(draft.filter((entry) => !entry.enabled).map((entry) => entry.step.id));
  const issues: string[] = [];
  for (const entry of draft) {
    if (!entry.enabled) continue;
    for (const input of entry.step.inputs) {
      if (disabled.has(input))
        issues.push(
          `${entry.step.id} depends on ${input}; re-enable it or turn off ${entry.step.id}.`,
        );
    }
  }
  if (issues.length > 0) return issues;
  const result = validatePlanEdit(proposed, draftToSteps(draft));
  return result.ok ? [] : result.issues;
}

export function budgetTotal(draft: readonly DraftStep[]): number {
  return draftToSteps(draft).reduce((sum, step) => sum + step.budgetShare, 0);
}

export type StepChange = "added" | "removed" | "changed" | "same";

export interface PlanDiffRow {
  step: PlanStep;
  change: StepChange;
  fields: (keyof PlanStep)[];
}

const COMPARED_FIELDS: (keyof PlanStep)[] = [
  "objective",
  "role",
  "inputs",
  "capabilities",
  "acceptance",
  "budgetShare",
];

export function planDiffRows(
  previous: readonly PlanStep[],
  next: readonly PlanStep[],
): PlanDiffRow[] {
  const before = new Map(previous.map((step) => [step.id, step]));
  const after = new Set(next.map((step) => step.id));
  const rows: PlanDiffRow[] = next.map((step) => {
    const old = before.get(step.id);
    if (old === undefined) return { step, change: "added", fields: [] };
    const fields = COMPARED_FIELDS.filter(
      (field) => JSON.stringify(old[field]) !== JSON.stringify(step[field]),
    );
    return { step, change: fields.length === 0 ? "same" : "changed", fields };
  });
  for (const step of previous) {
    if (!after.has(step.id)) rows.push({ step, change: "removed", fields: [] });
  }
  return rows;
}

export interface PlanVersion {
  version: number;
  steps: PlanStep[];
  kind: "proposed" | "revised";
  reason: string | null;
  at: string;
  seq: number;
}

export function planVersions(events: readonly RunEvent[]): PlanVersion[] {
  const versions: PlanVersion[] = [];
  for (const event of events) {
    if (event.type === "plan.proposed") {
      versions.push({
        version: event.payload.version,
        steps: event.payload.steps,
        kind: "proposed",
        reason: null,
        at: event.at,
        seq: event.seq,
      });
    } else if (event.type === "plan.revised") {
      versions.push({
        version: event.payload.version,
        steps: event.payload.steps,
        kind: "revised",
        reason: event.payload.reason,
        at: event.at,
        seq: event.seq,
      });
    }
  }
  return versions;
}

export function stepDepths(steps: readonly PlanStep[]): Map<string, number> {
  const depths = new Map<string, number>();
  const byId = new Map(steps.map((step) => [step.id, step]));
  const depth = (id: string, trail: Set<string>): number => {
    const known = depths.get(id);
    if (known !== undefined) return known;
    const step = byId.get(id);
    if (step === undefined || trail.has(id)) return 0;
    trail.add(id);
    const value =
      step.inputs.length === 0
        ? 0
        : 1 + Math.max(...step.inputs.map((input) => depth(input, trail)));
    trail.delete(id);
    depths.set(id, value);
    return value;
  };
  for (const step of steps) depth(step.id, new Set());
  return depths;
}
