import { auditLog, recordAudit, runs, withTenant } from "@delegate/db";
import { AUTOPILOT_MISSION_ID } from "@delegate/runtime";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { type ApiDeps, apiError, NO_STORE, readJson } from "../api";
import { cancelAutopilotChildren } from "../autopilot";
import type { AppDatabase } from "../db";
import { appendEvent, type EventDraft, RunAlreadyTerminalError } from "../runs";
import type { GuestSession } from "../session";
import { RUNS_PAUSED_ACTION, RUNS_RESUMED_ACTION, setRunsPaused } from "../workspace-settings";
import { issuesOf, operatorFor, postgresCode } from "./http";

export const RUNS_STOPPED_ACTION = "workspace.runs_stopped";
export const STOP_ALL_CONFIRMATION = "stop all runs";
export const STOP_ALL_MAX_RUNS = 200;
const AUDITED_RUN_IDS = 50;

const CANCELLED_BY_USER: EventDraft = {
  type: "run.failed",
  payload: { error: { code: "cancelled", message: "cancelled by user" } },
};

export const PauseRequestSchema = z.strictObject({ paused: z.boolean() });

export const StopAllRequestSchema = z.strictObject({
  confirm: z.literal(STOP_ALL_CONFIRMATION),
});

export async function handleSetRunsPaused(request: Request, deps: ApiDeps): Promise<Response> {
  const operator = await operatorFor(request, deps, "change the safety switches");
  if (operator instanceof Response) return operator;
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const parsed = PauseRequestSchema.safeParse(body.value);
  if (!parsed.success)
    return apiError(400, "invalid_request", "The switch request is not valid.", {
      issues: issuesOf(parsed.error),
    });
  try {
    const result = await setRunsPaused(operator.app, operator.session, parsed.data.paused);
    return Response.json(
      {
        paused: result.pausedAt !== null,
        pausedAt: result.pausedAt?.toISOString() ?? null,
        changed: result.changed,
      },
      { headers: NO_STORE },
    );
  } catch (error: unknown) {
    if (postgresCode(error) === "42501")
      return apiError(403, "forbidden", "Your role cannot pause or resume runs.");
    console.error("pause switch failed", error instanceof Error ? error.name : "unknown");
    return apiError(500, "internal", "The switch could not be changed.");
  }
}

export interface StopAllResult {
  stopped: number;
  runIds: string[];
}

export async function stopAllRuns(
  app: AppDatabase,
  session: GuestSession,
  deps: Pick<ApiDeps, "registry" | "runner">,
): Promise<StopAllResult> {
  const active = await withTenant(app.db, session.userId, async (tx) => {
    const rows = await tx
      .select({ id: runs.id, mission: runs.mission })
      .from(runs)
      .where(
        and(
          eq(runs.workspaceId, session.workspaceId),
          sql`${runs.status} not in ('completed', 'failed')`,
        ),
      )
      .orderBy(asc(runs.createdAt))
      .limit(STOP_ALL_MAX_RUNS);
    if (rows.length > 0)
      await recordAudit(tx, {
        workspaceId: session.workspaceId,
        action: RUNS_STOPPED_ACTION,
        target: `workspace:${session.workspaceId}`,
        decision: "n/a",
        details: {
          activeRuns: rows.length,
          runIds: rows.slice(0, AUDITED_RUN_IDS).map((row) => row.id),
        },
      });
    return rows;
  });
  const parentsFirst = [
    ...active.filter((run) => run.mission === AUTOPILOT_MISSION_ID),
    ...active.filter((run) => run.mission !== AUTOPILOT_MISSION_ID),
  ];
  for (const run of parentsFirst) {
    try {
      await appendEvent(
        app,
        { runId: run.id, workspaceId: session.workspaceId, userId: session.userId },
        CANCELLED_BY_USER,
      );
    } catch (error: unknown) {
      if (error instanceof RunAlreadyTerminalError) continue;
      throw error;
    }
    deps.registry.abort(run.id, "cancelled by user");
    if (run.mission === AUTOPILOT_MISSION_ID)
      await cancelAutopilotChildren(app, session.userId, run.id, deps);
  }
  return { stopped: active.length, runIds: active.map((run) => run.id) };
}

export async function handleStopAllRuns(request: Request, deps: ApiDeps): Promise<Response> {
  const operator = await operatorFor(request, deps, "stop runs");
  if (operator instanceof Response) return operator;
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const parsed = StopAllRequestSchema.safeParse(body.value);
  if (!parsed.success)
    return apiError(
      400,
      "invalid_request",
      `Confirm by sending { "confirm": "${STOP_ALL_CONFIRMATION}" }.`,
      { issues: issuesOf(parsed.error) },
    );
  try {
    const result = await stopAllRuns(operator.app, operator.session, deps);
    return Response.json(result, { headers: NO_STORE });
  } catch (error: unknown) {
    if (postgresCode(error) === "42501")
      return apiError(403, "forbidden", "Your role cannot stop runs.");
    console.error("stop all runs failed", error instanceof Error ? error.name : "unknown");
    return apiError(500, "internal", "Not every run could be stopped. Reload to see what is left.");
  }
}

export type SwitchAction =
  typeof RUNS_PAUSED_ACTION | typeof RUNS_RESUMED_ACTION | typeof RUNS_STOPPED_ACTION;

export interface SwitchActivity {
  id: number;
  action: SwitchAction;
  at: Date;
  runs: number | null;
}

const SWITCH_ACTIONS: readonly SwitchAction[] = [
  RUNS_PAUSED_ACTION,
  RUNS_RESUMED_ACTION,
  RUNS_STOPPED_ACTION,
];

const stoppedDetails = z.object({ activeRuns: z.number().int().nonnegative() });

export async function recentSwitchActivity(
  app: AppDatabase,
  session: GuestSession,
  limit = 5,
): Promise<SwitchActivity[]> {
  const rows = await withTenant(app.db, session.userId, (tx) =>
    tx
      .select({
        id: auditLog.id,
        action: auditLog.action,
        details: auditLog.details,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.workspaceId, session.workspaceId),
          inArray(auditLog.action, [...SWITCH_ACTIONS]),
        ),
      )
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(limit),
  );
  return rows.flatMap((row) => {
    const action = SWITCH_ACTIONS.find((known) => known === row.action);
    if (action === undefined) return [];
    const details = stoppedDetails.safeParse(row.details);
    return [
      {
        id: row.id,
        action,
        at: row.createdAt,
        runs: details.success ? details.data.activeRuns : null,
      },
    ];
  });
}
