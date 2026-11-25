import { createHash } from "node:crypto";

import {
  addRunUsage,
  appendRunEvent,
  artifacts,
  type RunEventRow,
  runEventFromRow,
  runEvents,
  runs,
  runTotalsSchema,
  type TenantTx,
  withTenant,
} from "@delegate/db";
import type { RunEvent, RunEventType, RunStatus } from "@delegate/runtime";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";

import type { AppDatabase } from "./db";
import type { GuestSession } from "./session";

export const GUEST_RUN_BUDGET = { maxTokens: 400_000, maxMicroUsd: 0 } as const;
export const MAX_RUN_DURATION_MS = 5 * 60_000;
export const STALE_AFTER_MS = 2 * 60_000;
export const PLAN_APPROVAL_GRACE_MS = 10 * 60_000 + STALE_AFTER_MS;
export const REPLAY_PAGE_SIZE = 500;

export type Execution = "live" | "simulated";

export interface RunContext {
  runId: string;
  workspaceId: string;
  userId: string;
}

export interface EventDraft {
  type: RunEventType;
  payload: unknown;
  stepId?: string;
  agentId?: string;
}

export class RunAlreadyTerminalError extends Error {
  override readonly name = "RunAlreadyTerminalError";
  constructor(readonly runId: string) {
    super(`run ${runId} already reached a terminal state`);
  }
}

export function isTerminalEventType(type: string): boolean {
  return type === "run.completed" || type === "run.failed";
}

export interface RunRecord {
  id: string;
  workspaceId: string;
  mission: string;
  input: Record<string, unknown>;
  execution: Execution;
  status: RunStatus;
  totals: z.infer<typeof runTotalsSchema>;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  eventCount: number;
  lastEventAt: Date | null;
  lastEventType: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
}

const inputRecord = z.record(z.string(), z.unknown());

function executionOf(input: Record<string, unknown>): Execution {
  return input.execution === "simulated" ? "simulated" : "live";
}

export function missionInputOf(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([key]) => key !== "execution" && key !== "parentRunId"),
  );
}

export async function createRunRecord(
  app: AppDatabase,
  session: GuestSession,
  request: {
    missionId: string;
    input: Record<string, unknown>;
    execution: Execution;
    parentRunId?: string;
  },
): Promise<{ runId: string; event: RunEvent }> {
  const storedInput =
    request.execution === "simulated"
      ? { ...request.input, execution: "simulated" }
      : request.input;
  return withTenant(app.db, session.userId, async (tx) => {
    const [run] = await tx
      .insert(runs)
      .values({
        workspaceId: session.workspaceId,
        mission: request.missionId,
        input: storedInput,
        budget: { ...GUEST_RUN_BUDGET },
        ...(request.parentRunId === undefined ? {} : { parentRunId: request.parentRunId }),
      })
      .returning({ id: runs.id });
    if (run === undefined) throw new Error("run insert returned no row");
    const row = await appendRunEvent(tx, {
      runId: run.id,
      workspaceId: session.workspaceId,
      type: "run.created",
      payload: {
        workspaceId: session.workspaceId,
        missionId: request.missionId,
        input:
          request.parentRunId === undefined
            ? storedInput
            : { ...storedInput, parentRunId: request.parentRunId },
        actor: { type: "guest", id: session.userId },
        budget: { ...GUEST_RUN_BUDGET },
      },
    });
    return { runId: run.id, event: runEventFromRow(row) };
  });
}

const STATUS_AFTER: Partial<Record<RunEventType, RunStatus>> = {
  "plan.proposed": "awaiting_plan_approval",
  "plan.approved": "running",
  "step.started": "running",
  "approval.requested": "awaiting_approval",
  "approval.resolved": "running",
  "run.completed": "completed",
  "run.failed": "failed",
};

export function artifactRowId(runId: string, artifactId: string): string {
  const hex = createHash("sha256").update(`${runId}:${artifactId}`).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${((Number.parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${hex.slice(18, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

const artifactCreatedPayload = z.object({
  artifactId: z.string(),
  kind: z.string(),
  title: z.string(),
  content: z.unknown().optional(),
});
const artifactUpdatedPayload = z.object({
  artifactId: z.string(),
  version: z.int(),
  title: z.string().optional(),
  content: z.unknown().optional(),
});

async function lastEventType(tx: TenantTx, runId: string): Promise<string | null> {
  const [last] = await tx
    .select({ type: runEvents.type })
    .from(runEvents)
    .where(eq(runEvents.runId, runId))
    .orderBy(desc(runEvents.seq))
    .limit(1);
  return last?.type ?? null;
}

async function storeArtifact(tx: TenantTx, ctx: RunContext, event: RunEvent): Promise<void> {
  if (event.type === "artifact.created") {
    const payload = artifactCreatedPayload.parse(event.payload);
    if (payload.content === undefined) return;
    await tx.insert(artifacts).values({
      id: artifactRowId(ctx.runId, payload.artifactId),
      runId: ctx.runId,
      workspaceId: ctx.workspaceId,
      kind: payload.kind,
      title: payload.title,
      content: payload.content,
      version: 1,
    });
  } else if (event.type === "artifact.updated") {
    const payload = artifactUpdatedPayload.parse(event.payload);
    if (payload.content === undefined) return;
    await tx
      .update(artifacts)
      .set({
        content: payload.content,
        version: payload.version,
        ...(payload.title === undefined ? {} : { title: payload.title }),
      })
      .where(eq(artifacts.id, artifactRowId(ctx.runId, payload.artifactId)));
  }
}

async function mirrorRun(tx: TenantTx, ctx: RunContext, event: RunEvent): Promise<void> {
  if (event.type === "usage.updated") {
    await addRunUsage(
      tx,
      ctx.runId,
      runTotalsSchema.parse({
        inputTokens: event.payload.inputTokens,
        outputTokens: event.payload.outputTokens,
        cacheReadTokens: event.payload.cacheReadTokens,
        cacheWriteTokens: event.payload.cacheWriteTokens,
        costMicroUsd: event.payload.costMicroUsd,
      }),
    );
  }
  const status = STATUS_AFTER[event.type];
  if (status === undefined) return;
  const terminal = isTerminalEventType(event.type);
  await tx
    .update(runs)
    .set({
      status,
      startedAt: sql`coalesce(${runs.startedAt}, now())`,
      ...(terminal ? { finishedAt: sql`now()` } : {}),
    })
    .where(eq(runs.id, ctx.runId));
}

export async function appendEvent(
  app: AppDatabase,
  ctx: RunContext,
  draft: EventDraft,
): Promise<RunEvent> {
  return withTenant(app.db, ctx.userId, async (tx) => {
    await tx
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.id, ctx.runId), eq(runs.workspaceId, ctx.workspaceId)))
      .for("update");
    const last = await lastEventType(tx, ctx.runId);
    if (last !== null && isTerminalEventType(last)) throw new RunAlreadyTerminalError(ctx.runId);
    const row = await appendRunEvent(tx, {
      runId: ctx.runId,
      workspaceId: ctx.workspaceId,
      type: draft.type,
      payload: draft.payload,
      ...(draft.stepId === undefined ? {} : { stepId: draft.stepId }),
      ...(draft.agentId === undefined ? {} : { agentId: draft.agentId }),
    });
    const event = runEventFromRow(row);
    await storeArtifact(tx, ctx, event);
    await mirrorRun(tx, ctx, event);
    return event;
  });
}

export async function readEvents(
  app: AppDatabase,
  userId: string,
  runId: string,
  afterSeq: number,
  limit = REPLAY_PAGE_SIZE,
): Promise<RunEvent[]> {
  const rows: RunEventRow[] = await withTenant(app.db, userId, (tx) =>
    tx
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, afterSeq)))
      .orderBy(asc(runEvents.seq))
      .limit(limit),
  );
  return rows.map(runEventFromRow);
}

const statsRow = z.object({
  count: z.coerce.number().int(),
  last_at: z.union([z.date(), z.string(), z.null()]),
});

function toDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

export async function getRunRecord(
  app: AppDatabase,
  userId: string,
  runId: string,
): Promise<RunRecord | null> {
  if (!z.uuid().safeParse(runId).success) return null;
  return withTenant(app.db, userId, async (tx) => {
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId));
    if (run === undefined) return null;
    const stats = await tx.execute(
      sql`select count(*) as count, max(${runEvents.createdAt}) as last_at
          from ${runEvents} where ${runEvents.runId} = ${runId}`,
    );
    const stat = statsRow.parse(z.object({ rows: z.array(z.unknown()) }).parse(stats).rows[0]);
    const input = inputRecord.parse(run.input);
    return {
      id: run.id,
      workspaceId: run.workspaceId,
      mission: run.mission,
      input,
      execution: executionOf(input),
      status: run.status,
      totals: runTotalsSchema.parse(run.totals),
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      eventCount: stat.count,
      lastEventAt: toDate(stat.last_at),
      lastEventType: await lastEventType(tx, runId),
      leaseOwner: run.leaseOwner,
      leaseExpiresAt: run.leaseExpiresAt,
    };
  });
}

export interface RunListItem {
  id: string;
  mission: string;
  target: string | null;
  execution: Execution;
  status: RunStatus;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export async function listRuns(
  app: AppDatabase,
  session: GuestSession,
  limit = 50,
): Promise<RunListItem[]> {
  const rows = await withTenant(app.db, session.userId, (tx) =>
    tx
      .select()
      .from(runs)
      .where(eq(runs.workspaceId, session.workspaceId))
      .orderBy(desc(runs.createdAt))
      .limit(limit),
  );
  return rows.map((run) => {
    const input = inputRecord.safeParse(run.input);
    const url = input.success && typeof input.data.url === "string" ? input.data.url : null;
    return {
      id: run.id,
      mission: run.mission,
      target: url === null ? null : new URL(url).hostname.replace(/^www\./, ""),
      execution: input.success ? executionOf(input.data) : "live",
      status: run.status,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    };
  });
}

export function isStale(record: RunRecord, now: Date): boolean {
  if (record.lastEventType !== null && isTerminalEventType(record.lastEventType)) return false;
  const age = now.getTime() - record.createdAt.getTime();
  const silence = now.getTime() - (record.lastEventAt ?? record.createdAt).getTime();
  const quietLimit =
    record.lastEventType === "plan.proposed" || record.lastEventType === "ship.approval.requested"
      ? PLAN_APPROVAL_GRACE_MS
      : STALE_AFTER_MS;
  return age > MAX_RUN_DURATION_MS && silence > quietLimit;
}

export async function sweepIfStale(
  app: AppDatabase,
  userId: string,
  record: RunRecord,
  now = new Date(),
): Promise<boolean> {
  if (!isStale(record, now)) return false;
  try {
    await appendEvent(
      app,
      { runId: record.id, workspaceId: record.workspaceId, userId },
      { type: "run.failed", payload: { error: { code: "worker_lost", message: "worker lost" } } },
    );
    return true;
  } catch (error: unknown) {
    if (error instanceof RunAlreadyTerminalError) return false;
    throw error;
  }
}

export async function readAllEvents(
  app: AppDatabase,
  userId: string,
  runId: string,
): Promise<RunEvent[]> {
  const all: RunEvent[] = [];
  for (;;) {
    const page = await readEvents(app, userId, runId, all.at(-1)?.seq ?? 0);
    all.push(...page);
    if (page.length < REPLAY_PAGE_SIZE) return all;
  }
}

export async function listOpenRuns(
  app: AppDatabase,
  session: GuestSession,
  limit = 20,
): Promise<string[]> {
  const rows = await withTenant(app.db, session.userId, (tx) =>
    tx
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.workspaceId, session.workspaceId),
          sql`${runs.status} not in ('completed', 'failed')`,
        ),
      )
      .orderBy(desc(runs.createdAt))
      .limit(limit),
  );
  return rows.map((row) => row.id);
}

export interface ArtifactContent {
  artifactId: string;
  kind: string;
  title: string;
  version: number;
  content: unknown;
}

export async function artifactContent(
  app: AppDatabase,
  userId: string,
  runId: string,
  artifactId: string,
): Promise<ArtifactContent | null> {
  if (!z.uuid().safeParse(runId).success) return null;
  const [row] = await withTenant(app.db, userId, (tx) =>
    tx
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.runId, runId), eq(artifacts.id, artifactRowId(runId, artifactId)))),
  );
  if (row === undefined) return null;
  return {
    artifactId,
    kind: row.kind,
    title: row.title,
    version: row.version,
    content: row.content,
  };
}
