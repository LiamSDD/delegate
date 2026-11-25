import { runEvents, runs, runTotalsSchema, type TenantTx, withTenant } from "@delegate/db";
import { AUTOPILOT_MISSION_ID, type RunStatus } from "@delegate/runtime";
import { and, asc, desc, eq, inArray, type SQL, sql } from "drizzle-orm";
import { z } from "zod";

import { runTarget } from "@/lib/runs/target";

import type { AppDatabase } from "../db";
import { type Execution, STALE_AFTER_MS } from "../runs";
import type { GuestSession } from "../session";

export const ACTIVE_RUNS_LIMIT = 50;

export interface RunStep {
  id: string;
  state: "running" | "finished";
}

export interface RunSnapshot {
  id: string;
  mission: string;
  target: string | null;
  execution: Execution;
  status: RunStatus;
  createdAt: Date;
  finishedAt: Date | null;
  lastEventAt: Date | null;
  tokens: number;
  step: RunStep | null;
  stalled: boolean;
}

export interface ActiveRun extends RunSnapshot {
  children: RunSnapshot[];
}

export interface ActiveRuns {
  runs: ActiveRun[];
  truncated: boolean;
}

const inputRecord = z.record(z.string(), z.unknown());

const WAITING_ON_A_PERSON: ReadonlySet<RunStatus> = new Set([
  "awaiting_plan_approval",
  "awaiting_approval",
]);

function isActive(status: RunStatus): boolean {
  return status !== "completed" && status !== "failed";
}

async function snapshots(
  tx: TenantTx,
  where: SQL | undefined,
  now: Date,
  limit: number,
): Promise<(RunSnapshot & { parentRunId: string | null })[]> {
  const last = tx
    .select({ at: runEvents.createdAt })
    .from(runEvents)
    .where(eq(runEvents.runId, runs.id))
    .orderBy(desc(runEvents.seq))
    .limit(1)
    .as("last_event");
  const step = tx
    .select({ stepId: runEvents.stepId, type: runEvents.type })
    .from(runEvents)
    .where(
      and(
        eq(runEvents.runId, runs.id),
        inArray(runEvents.type, ["step.started", "step.completed"]),
      ),
    )
    .orderBy(desc(runEvents.seq))
    .limit(1)
    .as("step_event");
  const rows = await tx
    .select({
      id: runs.id,
      mission: runs.mission,
      input: runs.input,
      status: runs.status,
      totals: runs.totals,
      createdAt: runs.createdAt,
      finishedAt: runs.finishedAt,
      parentRunId: runs.parentRunId,
      lastEventAt: last.at,
      stepId: step.stepId,
      stepType: step.type,
    })
    .from(runs)
    .leftJoinLateral(last, sql`true`)
    .leftJoinLateral(step, sql`true`)
    .where(where)
    .orderBy(desc(runs.createdAt), asc(runs.id))
    .limit(limit);
  return rows.map((row) => {
    const input = inputRecord.safeParse(row.input);
    const totals = runTotalsSchema.safeParse(row.totals);
    const quietMs = now.getTime() - (row.lastEventAt ?? row.createdAt).getTime();
    return {
      id: row.id,
      mission: row.mission,
      target: input.success ? runTarget(input.data) : null,
      execution: input.success && input.data.execution === "simulated" ? "simulated" : "live",
      status: row.status,
      createdAt: row.createdAt,
      finishedAt: row.finishedAt,
      lastEventAt: row.lastEventAt,
      tokens: totals.success ? totals.data.inputTokens + totals.data.outputTokens : 0,
      step:
        row.stepId === null || row.stepType === null
          ? null
          : { id: row.stepId, state: row.stepType === "step.started" ? "running" : "finished" },
      stalled:
        isActive(row.status) &&
        row.mission !== AUTOPILOT_MISSION_ID &&
        !WAITING_ON_A_PERSON.has(row.status) &&
        quietMs > STALE_AFTER_MS,
      parentRunId: row.parentRunId,
    };
  });
}

export async function listActiveRuns(
  app: AppDatabase,
  session: GuestSession,
  now = new Date(),
): Promise<ActiveRuns> {
  return withTenant(app.db, session.userId, async (tx) => {
    const inWorkspace = eq(runs.workspaceId, session.workspaceId);
    const active = await snapshots(
      tx,
      and(inWorkspace, sql`${runs.status} not in ('completed', 'failed')`),
      now,
      ACTIVE_RUNS_LIMIT + 1,
    );
    const shown = active.slice(0, ACTIVE_RUNS_LIMIT);
    const parents = shown.filter((run) => run.mission === AUTOPILOT_MISSION_ID);
    const children =
      parents.length === 0
        ? []
        : await snapshots(
            tx,
            and(
              inWorkspace,
              inArray(
                runs.parentRunId,
                parents.map((run) => run.id),
              ),
            ),
            now,
            parents.length * 8,
          );
    const parentIds = new Set(parents.map((run) => run.id));
    return {
      truncated: active.length > ACTIVE_RUNS_LIMIT,
      runs: shown
        .filter((run) => run.parentRunId === null || !parentIds.has(run.parentRunId))
        .map(({ parentRunId: _parent, ...run }) => ({
          ...run,
          children: children
            .filter((child) => child.parentRunId === run.id)
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
            .map(({ parentRunId: _childParent, ...child }) => child),
        })),
    };
  });
}
