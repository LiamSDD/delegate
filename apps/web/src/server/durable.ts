import { analyseForResume } from "@delegate/runtime/server";

import type { RunnableMissionId } from "@/lib/m2-contract";
import { MAX_RESUMES, resumeDecision, resumeMarkerDraft, resumeNotices } from "@/lib/runs/resume";

import type { AppDatabase } from "./db";
import { executeRun } from "./execute-run";
import { createDbLease } from "./leases";
import type { MissionRunner } from "./mission-runner";
import type { RunRegistry } from "./run-registry";
import {
  appendEvent,
  type Execution,
  getRunRecord,
  isTerminalEventType,
  readAllEvents,
  RunAlreadyTerminalError,
  type RunRecord,
  sweepIfStale,
} from "./runs";

export interface DurableDeps {
  registry: RunRegistry;
  runner: () => { execution: Execution; run: MissionRunner };
  schedule: (task: () => Promise<void>) => void;
  now?: () => Date;
}

const holder = globalThis as typeof globalThis & { __delegateResuming?: Set<string> };

function resuming(): Set<string> {
  holder.__delegateResuming ??= new Set();
  return holder.__delegateResuming;
}

function isRunnable(mission: string): mission is RunnableMissionId {
  return mission === "company-xray" || mission === "automation-audit" || mission === "build-agent";
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
  if (analysis.kind === "finished" || !isRunnable(record.mission)) {
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
    }),
  );
}

export async function reviveOrSweep(
  app: AppDatabase,
  userId: string,
  record: RunRecord,
  deps: DurableDeps,
): Promise<RunRecord | null> {
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
