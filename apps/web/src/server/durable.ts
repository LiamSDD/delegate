import { AUTOPILOT_MISSION_ID, type ChildStartedPayload, foldRun } from "@delegate/runtime";
import { analyseForResume, type FindInstallation } from "@delegate/runtime/server";

import { isExecutableMission } from "@/lib/m2-contract";
import { MAX_RESUMES, resumeDecision, resumeMarkerDraft, resumeNotices } from "@/lib/runs/resume";

import { advanceAutopilot, autopilotLinkOf } from "./autopilot";
import type { AppDatabase } from "./db";
import { executeRun } from "./execute-run";
import type { MissionConnections } from "./mission-runner";
import { createDbLease } from "./leases";
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
) {
  try {
    await appendEvent(
      app,
      { runId: record.id, workspaceId: record.workspaceId, userId },
      { type: "run.failed", payload: { error: { code: "worker_lost", message } } },
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
): Promise<void> {
  const ctx = { runId: record.id, workspaceId: record.workspaceId, userId };
  const lease = createDbLease(app, ctx);
  if (!(await lease.acquire())) return;
  const events = await readAllEvents(app, userId, record.id);
  if (resumeNotices(events).length >= MAX_RESUMES) {
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
  const marker = resumeMarkerDraft({
    skipped: analysis.completedSteps.length,
    rerun: analysis.rerunSteps.length,
  });
  await appendEvent(app, ctx, marker);
  const resumeFrom = await readAllEvents(app, userId, record.id);
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
  const decision = resumeDecision(
    {
      terminal: record.lastEventType !== null && isTerminalEventType(record.lastEventType),
      execution: record.execution,
      mission: record.mission,
      leaseExpiresAt: record.leaseExpiresAt,
      lastEventAt: record.lastEventAt,
      createdAt: record.createdAt,
      activeHere: deps.registry.has(record.id) || resuming().has(record.id),
      resumes: 0,
    },
    now,
  );
  if (decision === "resume") {
    resuming().add(record.id);
    try {
      await resumeRun(app, userId, record, deps);
    } catch (error: unknown) {
      console.error("resume failed", record.id, error);
    } finally {
      resuming().delete(record.id);
    }
    return getRunRecord(app, userId, record.id);
  }
  if (decision === "sweep" && (await sweepIfStale(app, userId, record, now))) {
    deps.registry.abort(record.id, "worker lost");
    return getRunRecord(app, userId, record.id);
  }
  return record;
}
