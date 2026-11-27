import {
  addRunUsage,
  appendRunEvent,
  artifacts,
  runEventFromRow,
  runEvents,
  runs,
  runTotalsSchema,
  withTenant,
} from "@delegate/db";
import {
  assembleForkLog,
  type ForkOrigin,
  type ForkPlan,
  foldRun,
  planFork,
  type RunEvent,
} from "@delegate/runtime";
import { eq, sql } from "drizzle-orm";

import { isHandoffMarker, RESUME_POLICY_ID } from "@/lib/runs/resume";

import type { AppDatabase } from "./db";
import {
  artifactRowId,
  type Execution,
  GUEST_RUN_BUDGET,
  missionInputOf,
  type RunRecord,
} from "./runs";
import type { GuestSession } from "./session";

const INSERT_CHUNK = 200;

export type ReadyFork = Extract<ForkPlan, { ok: true }>;

export function isResumeMarker(event: RunEvent): boolean {
  return (
    (event.type === "policy.decided" && event.payload.policyId === RESUME_POLICY_ID) ||
    isHandoffMarker(event)
  );
}

export function planRunFork(
  events: readonly RunEvent[],
  request: { stepId: string; objective?: string | undefined },
): ForkPlan {
  return planFork(events, {
    stepId: request.stepId,
    ...(request.objective === undefined ? {} : { objective: request.objective }),
    keep: (event) => !isResumeMarker(event),
  });
}

interface StoredArtifact {
  kind: string;
  title: string;
  version: number;
  content: unknown;
}

export function artifactsFromLog(events: readonly RunEvent[]): Map<string, StoredArtifact> {
  const stored = new Map<string, StoredArtifact>();
  for (const event of events) {
    if (event.type === "artifact.created" && event.payload.content !== undefined)
      stored.set(event.payload.artifactId, {
        kind: event.payload.kind,
        title: event.payload.title,
        version: 1,
        content: event.payload.content,
      });
    if (event.type === "artifact.updated") {
      const existing = stored.get(event.payload.artifactId);
      if (existing !== undefined && event.payload.content !== undefined)
        stored.set(event.payload.artifactId, {
          ...existing,
          version: event.payload.version,
          content: event.payload.content,
          ...(event.payload.title === undefined ? {} : { title: event.payload.title }),
        });
    }
  }
  return stored;
}

export function usageFromLog(events: readonly RunEvent[]) {
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costMicroUsd: 0,
  };
  for (const event of events) {
    if (event.type !== "usage.updated") continue;
    totals.inputTokens += event.payload.inputTokens;
    totals.outputTokens += event.payload.outputTokens;
    totals.cacheReadTokens += event.payload.cacheReadTokens;
    totals.cacheWriteTokens += event.payload.cacheWriteTokens;
    totals.costMicroUsd += event.payload.costMicroUsd;
  }
  return runTotalsSchema.parse(totals);
}

export interface CreatedFork {
  runId: string;
  origin: ForkOrigin;
  events: RunEvent[];
}

export async function createForkRecord(
  app: AppDatabase,
  session: GuestSession,
  parent: RunRecord,
  fork: ReadyFork,
  execution: Execution,
): Promise<CreatedFork> {
  const missionInput = missionInputOf(parent.input);
  const storedInput =
    execution === "simulated" ? { ...missionInput, execution: "simulated" } : missionInput;
  return withTenant(app.db, session.userId, async (tx) => {
    const [run] = await tx
      .insert(runs)
      .values({
        workspaceId: session.workspaceId,
        mission: parent.mission,
        input: storedInput,
        budget: { ...GUEST_RUN_BUDGET },
        parentRunId: parent.id,
        forkedFromSeq: fork.parentSeq,
      })
      .returning({ id: runs.id });
    if (run === undefined) throw new Error("fork insert returned no row");
    const origin: ForkOrigin = {
      runId: parent.id,
      stepId: fork.stepId,
      parentSeq: fork.parentSeq,
      seededThrough: fork.seed.length + 1,
      objectiveEdited: fork.objectiveEdited,
    };
    const createdRow = await appendRunEvent(tx, {
      runId: run.id,
      workspaceId: session.workspaceId,
      type: "run.created",
      payload: {
        workspaceId: session.workspaceId,
        missionId: parent.mission,
        input: storedInput,
        actor: { type: "guest", id: session.userId },
        budget: { ...GUEST_RUN_BUDGET },
        forkedFrom: origin,
      },
    });
    const created = runEventFromRow(createdRow);
    const log = assembleForkLog(created, fork.seed);
    const seeded = log.slice(1);
    for (let start = 0; start < seeded.length; start += INSERT_CHUNK) {
      await tx.insert(runEvents).values(
        seeded.slice(start, start + INSERT_CHUNK).map((event) => ({
          runId: run.id,
          workspaceId: session.workspaceId,
          seq: event.seq,
          type: event.type,
          payload: event.payload,
          stepId: event.stepId ?? null,
          agentId: event.agentId ?? null,
          createdAt: new Date(event.at),
        })),
      );
    }
    const stored = [...artifactsFromLog(seeded)];
    if (stored.length > 0)
      await tx.insert(artifacts).values(
        stored.map(([artifactId, artifact]) => ({
          id: artifactRowId(run.id, artifactId),
          runId: run.id,
          workspaceId: session.workspaceId,
          ...artifact,
        })),
      );
    const usage = usageFromLog(seeded);
    if (Object.values(usage).some((value) => value > 0)) await addRunUsage(tx, run.id, usage);
    const state = foldRun(log);
    if (state.status !== "planning")
      await tx
        .update(runs)
        .set({ status: state.status, startedAt: sql`now()` })
        .where(eq(runs.id, run.id));
    return {
      runId: run.id,
      origin,
      events: log,
    };
  });
}
