import type { RunEvent } from "@delegate/runtime";

export const FORK_TARGET_MS = 10_000;

export interface ForkInfo {
  parentRunId: string;
  stepId: string;
  objectiveEdited: boolean;
  seededEvents: number;
  firstNewEventMs: number | null;
  reusedSteps: string[];
  rerunSteps: string[];
}

export function forkInfo(events: readonly RunEvent[]): ForkInfo | null {
  const created = events[0];
  if (created?.type !== "run.created") return null;
  const origin = created.payload.forkedFrom;
  if (origin === undefined) return null;
  const seeded = events.filter((event) => event.seq <= origin.seededThrough);
  const fresh = events.filter((event) => event.seq > origin.seededThrough);
  const completed = new Set<string>();
  for (const event of seeded) {
    if (event.type === "step.started") completed.delete(event.stepId);
    if (event.type === "step.completed" && event.payload.outcome === "succeeded")
      completed.add(event.stepId);
  }
  const rerun: string[] = [];
  for (const event of fresh)
    if (event.type === "step.started" && !rerun.includes(event.stepId)) rerun.push(event.stepId);
  const first = fresh[0];
  return {
    parentRunId: origin.runId,
    stepId: origin.stepId,
    objectiveEdited: origin.objectiveEdited,
    seededEvents: origin.seededThrough - created.seq,
    firstNewEventMs:
      first === undefined ? null : Math.max(0, Date.parse(first.at) - Date.parse(created.at)),
    reusedSteps: [...completed].filter((id) => !rerun.includes(id)),
    rerunSteps: rerun,
  };
}
