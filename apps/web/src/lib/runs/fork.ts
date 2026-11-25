import type { RunEvent } from "@delegate/runtime";
import { z } from "zod";

export const FORK_TARGET_MS = 10_000;

const forkedSchema = z.object({ runId: z.uuid() });
const forkErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

export type ForkRunResult = { ok: true; runId: string } | { ok: false; message: string };

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

export async function forkRun(
  runId: string,
  request: { stepId: string; objective?: string },
  fetcher: Fetcher = (path, init) => fetch(path, init),
): Promise<ForkRunResult> {
  let response: Response;
  try {
    response = await fetcher(`/api/runs/${encodeURIComponent(runId)}/fork`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  } catch {
    return { ok: false, message: "Could not reach Delegate. Check your connection and try again." };
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.status === 201) {
    const created = forkedSchema.safeParse(body);
    if (created.success) return { ok: true, runId: created.data.runId };
  }
  const failure = forkErrorSchema.safeParse(body);
  return {
    ok: false,
    message: failure.success ? failure.data.error.message : "The run could not be forked.",
  };
}

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
