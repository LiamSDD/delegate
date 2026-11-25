import {
  diffPlans,
  foldRun,
  parseRunEvent,
  type PlanStep,
  PlanStepsSchema,
  type RunEvent,
} from "../events";

type WithoutEnvelope<T> = T extends unknown ? Omit<T, "runId" | "seq" | "at"> : never;
export type ForkSeedEvent = WithoutEnvelope<RunEvent>;

export const MAX_FORK_OBJECTIVE_CHARS = 2000;

export interface ForkableStep {
  id: string;
  objective: string;
  outcome: "succeeded" | "failed";
}

export type ForkRefusal = "run_not_finished" | "unknown_step" | "step_not_completed";

export type ForkPlan =
  | {
      ok: true;
      stepId: string;
      parentSeq: number;
      seed: ForkSeedEvent[];
      steps: PlanStep[];
      objectiveEdited: boolean;
      reusedSteps: string[];
    }
  | { ok: false; reason: ForkRefusal; message: string };

export interface ForkRequest {
  stepId: string;
  objective?: string;
  keep?: (event: RunEvent) => boolean;
}

function stripEnvelope(event: RunEvent): ForkSeedEvent {
  const { runId: _runId, seq: _seq, at: _at, ...rest } = event;
  return rest;
}

function lastOutcomes(events: readonly RunEvent[]): Map<string, "succeeded" | "failed"> {
  const outcomes = new Map<string, "succeeded" | "failed">();
  for (const event of events) {
    if (event.type === "step.started") outcomes.delete(event.stepId);
    if (event.type === "step.completed") outcomes.set(event.stepId, event.payload.outcome);
  }
  return outcomes;
}

export function forkableSteps(events: readonly RunEvent[]): ForkableStep[] {
  if (events.length === 0) return [];
  const state = foldRun(events);
  if (state.status !== "completed" && state.status !== "failed") return [];
  const outcomes = lastOutcomes(events);
  return (state.plan?.steps ?? []).flatMap((step) => {
    const outcome = outcomes.get(step.id);
    return outcome === undefined ? [] : [{ id: step.id, objective: step.objective, outcome }];
  });
}

export function planFork(events: readonly RunEvent[], request: ForkRequest): ForkPlan {
  const state = foldRun(events);
  if (state.status !== "completed" && state.status !== "failed")
    return { ok: false, reason: "run_not_finished", message: "Only finished runs can be forked." };
  const planned = state.plan?.steps ?? [];
  const chosen = planned.find((step) => step.id === request.stepId);
  if (chosen === undefined)
    return { ok: false, reason: "unknown_step", message: "That step is not in the run's plan." };
  if (!forkableSteps(events).some((step) => step.id === request.stepId))
    return {
      ok: false,
      reason: "step_not_completed",
      message: "Only a step that finished can be forked from.",
    };
  const cut = events.find(
    (event) => event.type === "step.started" && event.stepId === request.stepId,
  );
  if (cut === undefined)
    return { ok: false, reason: "step_not_completed", message: "That step never started." };

  const keep = request.keep ?? (() => true);
  const copied = events.filter(
    (event) => event.seq < cut.seq && event.type !== "run.created" && keep(event),
  );
  const objective = request.objective?.trim();
  const objectiveEdited =
    objective !== undefined && objective !== "" && objective !== chosen.objective;
  const seed = copied.map(stripEnvelope);
  const before = foldRun(events.filter((event) => event.seq < cut.seq));
  let steps = before.plan?.steps ?? planned;
  if (objectiveEdited) {
    const edited = PlanStepsSchema.parse(
      steps.map((step) =>
        step.id === request.stepId
          ? { ...step, objective: objective.slice(0, MAX_FORK_OBJECTIVE_CHARS) }
          : step,
      ),
    );
    seed.push({
      type: "plan.revised",
      payload: {
        version: (before.plan?.version ?? 0) + 1,
        steps: edited,
        reason: `Objective of ${request.stepId} edited when forking run ${state.runId}`,
        diff: diffPlans(steps, edited),
        source: "reviewer",
      },
    });
    steps = edited;
  }
  return {
    ok: true,
    stepId: request.stepId,
    parentSeq: copied.at(-1)?.seq ?? events[0]?.seq ?? 0,
    seed,
    steps,
    objectiveEdited,
    reusedSteps: before.steps.filter((step) => step.status === "succeeded").map((step) => step.id),
  };
}

export function assembleForkLog(
  created: RunEvent,
  seed: readonly ForkSeedEvent[],
  at: string = created.at,
): RunEvent[] {
  return [
    created,
    ...seed.map((event, index) =>
      parseRunEvent({ ...event, runId: created.runId, seq: created.seq + index + 1, at }),
    ),
  ];
}
