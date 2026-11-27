import {
  AUTOPILOT_MISSION_ID,
  type ChildStartedPayload,
  foldRun,
  type RunEvent,
} from "@delegate/runtime";
import { analyseForResume, type FindInstallation } from "@delegate/runtime/server";

import { isExecutableMission } from "@/lib/m2-contract";
import {
  awaitingPlanApproval,
  countHandoffs,
  stalledHandoffs,
  endedWithHandoff,
  MAX_HANDOFFS,
  MAX_RESUMES,
  type PlanWait,
  resumeDecision,
  resumeMarkerDraft,
  resumeNotices,
} from "@/lib/runs/resume";

import { advanceAutopilot, autopilotLinkOf } from "./autopilot";
import type { AppDatabase } from "./db";
import { executeRun } from "./execute-run";
import type { MissionConnections } from "./mission-runner";
import { hasRoomForWork } from "./invocation";
import { createDbLease } from "./leases";
import {
  latestPlanApproval,
  PLAN_TIMEOUT_MS,
  PLAN_TIMEOUT_REASON,
  PlanDecisionError,
  recordPlanDecision,
} from "./plan-approval";
import type { MissionRunner } from "./mission-runner";
import type { RunRegistry } from "./run-registry";
import type { RateLimiter } from "./session";
import {
  appendEvent,
  type Execution,
  getRunRecord,
  isTerminalEventType,
  readAllEvents,
  RunAlreadyTerminalError,
  type RunContext,
  type RunRecord,
  sweepIfStale,
} from "./runs";

export interface DurableDeps {
  registry: RunRegistry;
  runner: () => { execution: Execution; run: MissionRunner };
  schedule: (task: () => Promise<void>) => void;
  shipInstallations?: (workspaceId: string, userId: string) => FindInstallation;
  connections?: (app: AppDatabase, ctx: RunContext) => Promise<MissionConnections | undefined>;
  now?: () => Date;
  guestLimiter: RateLimiter;
  shipEnabled?: boolean;
}

const holder = globalThis as typeof globalThis & { __delegateResuming?: Set<string> };

function resuming(): Set<string> {
  holder.__delegateResuming ??= new Set();
  return holder.__delegateResuming;
}

async function failWorkerLost(
  app: AppDatabase,
  userId: string,
  record: RunRecord,
  message: string,
  code = "worker_lost",
) {
  try {
    await appendEvent(
      app,
      { runId: record.id, workspaceId: record.workspaceId, userId },
      { type: "run.failed", payload: { error: { code, message } } },
    );
  } catch (error: unknown) {
    if (!(error instanceof RunAlreadyTerminalError)) throw error;
  }
}

async function resumeRun(
  app: AppDatabase,
  userId: string,
  record: RunRecord,
  deps: DurableDeps,
  mode: "resume" | "continue",
): Promise<void> {
  const ctx = { runId: record.id, workspaceId: record.workspaceId, userId };
  const lease = createDbLease(app, ctx);
  if (!(await lease.acquire())) return;
  const events = await readAllEvents(app, userId, record.id);
  if (
    mode === "continue" &&
    (countHandoffs(events) >= MAX_HANDOFFS || stalledHandoffs(events) >= 2)
  ) {
    await lease.release();
    await failWorkerLost(
      app,
      userId,
      record,
      `The run made no progress or did not finish within ${String(MAX_HANDOFFS)} server invocations.`,
      "handoff_limit",
    );
    return;
  }
  if (mode === "resume" && resumeNotices(events).length >= MAX_RESUMES) {
    await lease.release();
    await failWorkerLost(app, userId, record, "worker lost again after the maximum resumes");
    return;
  }
  const analysis = analyseForResume(events);
  if (analysis.kind === "finished" || !isExecutableMission(record.mission)) {
    await lease.release();
    return;
  }
  const runner = deps.runner();
  if (runner.execution !== "live") {
    await lease.release();
    await failWorkerLost(app, userId, record, "worker lost");
    return;
  }
  if (mode === "resume")
    await appendEvent(
      app,
      ctx,
      resumeMarkerDraft({
        skipped: analysis.completedSteps.length,
        rerun: analysis.rerunSteps.length,
      }),
    );
  const resumeFrom = mode === "resume" ? await readAllEvents(app, userId, record.id) : events;
  const missionId = record.mission;
  const link = autopilotLinkOf(resumeFrom);
  const approvals =
    link === undefined ? undefined : await childApprovals(app, userId, link.parentRunId, record.id);
  const mayAsk = approvals === undefined || approvals.sideEffects === "ask";
  const connections =
    deps.connections === undefined || !mayAsk
      ? undefined
      : await deps.connections(app, ctx).catch(() => undefined);
  deps.schedule(() =>
    executeRun({
      app,
      ctx,
      missionId,
      input: record.input,
      runner: runner.run,
      registry: deps.registry,
      lease,
      resumeFrom,
      ...(approvals === undefined ? {} : { autoApprovePlan: approvals.plan === "auto" }),
      ...(connections === undefined ? {} : { connections }),
      ...(missionId === "ship-a-pr" && mayAsk && deps.shipInstallations !== undefined
        ? { findInstallation: deps.shipInstallations(record.workspaceId, userId) }
        : {}),
      ...(link === undefined
        ? {}
        : { onSettled: () => advanceAutopilot(app, userId, link.parentRunId, deps) }),
    }),
  );
}

async function childApprovals(
  app: AppDatabase,
  userId: string,
  parentRunId: string,
  childRunId: string,
): Promise<ChildStartedPayload["approvals"]> {
  const fallback = { plan: "human", sideEffects: "none" } as const;
  try {
    const parent = foldRun(await readAllEvents(app, userId, parentRunId));
    return parent.children.find((child) => child.childRunId === childRunId)?.approvals ?? fallback;
  } catch {
    return fallback;
  }
}

async function planWaitOf(
  app: AppDatabase,
  userId: string,
  record: RunRecord,
  events: readonly RunEvent[],
  now: Date,
): Promise<PlanWait | undefined> {
  if (!awaitingPlanApproval(events)) return undefined;
  const approval = await latestPlanApproval(app, userId, record.id);
  if (approval === null) return undefined;
  if (approval.status !== "pending") return "due";
  if (approval.requestedAt.getTime() + PLAN_TIMEOUT_MS > now.getTime()) return "pending";
  try {
    await recordPlanDecision(
      app,
      { runId: record.id, workspaceId: record.workspaceId, userId },
      approval.approvalId,
      { decision: "rejected", reason: PLAN_TIMEOUT_REASON },
    );
  } catch (error: unknown) {
    if (!(error instanceof PlanDecisionError)) throw error;
  }
  return "due";
}

function leaseHeld(record: RunRecord, now: Date): boolean {
  return record.leaseExpiresAt !== null && record.leaseExpiresAt.getTime() > now.getTime();
}

export async function reviveOrSweep(
  app: AppDatabase,
  userId: string,
  record: RunRecord,
  deps: DurableDeps,
): Promise<RunRecord | null> {
  if (record.mission === AUTOPILOT_MISSION_ID) {
    if (record.lastEventType !== null && isTerminalEventType(record.lastEventType)) return record;
    await advanceAutopilot(app, userId, record.id, deps);
    return getRunRecord(app, userId, record.id);
  }
  const now = deps.now?.() ?? new Date();
  const terminal = record.lastEventType !== null && isTerminalEventType(record.lastEventType);
  const activeHere = deps.registry.has(record.id) || resuming().has(record.id);
  if (terminal || activeHere || leaseHeld(record, now)) return record;
  resuming().add(record.id);
  try {
    return await decideAndResume(app, userId, record, deps, now);
  } finally {
    resuming().delete(record.id);
  }
}

async function decideAndResume(
  app: AppDatabase,
  userId: string,
  record: RunRecord,
  deps: DurableDeps,
  now: Date,
): Promise<RunRecord | null> {
  const events = await readAllEvents(app, userId, record.id);
  const decision = resumeDecision(
    {
      terminal: false,
      execution: record.execution,
      mission: record.mission,
      leaseExpiresAt: record.leaseExpiresAt,
      lastEventAt: record.lastEventAt,
      createdAt: record.createdAt,
      activeHere: false,
      resumes: 0,
      handedOff: endedWithHandoff(events),
      ...(await planWaitOf(app, userId, record, events, now).then((planWait) =>
        planWait === undefined ? {} : { planWait },
      )),
    },
    now,
  );
  if (decision === "resume" || decision === "continue") {
    if (!hasRoomForWork(Date.now())) return record;
    try {
      await resumeRun(app, userId, record, deps, decision);
    } catch (error: unknown) {
      console.error("resume failed", record.id, error);
    }
    return getRunRecord(app, userId, record.id);
  }
  if (decision === "sweep" && (await sweepIfStale(app, userId, record, now))) {
    deps.registry.abort(record.id, "worker lost");
    return getRunRecord(app, userId, record.id);
  }
  return record;
}

export const WAKE_ATTEMPTS = 4;
export const WAKE_RETRY_MS = 1_500;

export async function wakeRun(
  app: AppDatabase,
  userId: string,
  runId: string,
  deps: DurableDeps,
  retryMs = WAKE_RETRY_MS,
): Promise<void> {
  try {
    for (let attempt = 0; attempt < WAKE_ATTEMPTS; attempt += 1) {
      const record = await getRunRecord(app, userId, runId);
      if (record === null) return;
      const now = deps.now?.() ?? new Date();
      const busyBefore = leaseHeld(record, now) || deps.registry.has(runId);
      const after = await reviveOrSweep(app, userId, record, deps);
      const waiting = busyBefore && after !== null && after.status === "awaiting_plan_approval";
      if (!waiting) return;
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  } catch (error: unknown) {
    console.error("waking the run failed", runId, error instanceof Error ? error.message : "");
  }
}
