import { type RunEvent, parseRunEvent } from "@delegate/runtime";
import { Pool } from "@neondatabase/serverless";
import { type ExtractTablesWithRelations, type SQL, and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-serverless";
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import { z } from "zod";

import { RUN_EVENT_TYPES } from "./event-types";
import { type RunTotals, runTotalsSchema } from "./run-json";
import * as schema from "./schema";
import { approvals, auditActorType, auditDecision, runEvents, runs } from "./schema";

export type DbSchema = typeof schema;

export type Database = PgDatabase<PgQueryResultHKT, DbSchema>;

export type TenantTx = PgTransaction<
  PgQueryResultHKT,
  DbSchema,
  ExtractTablesWithRelations<DbSchema>
>;

type Executor = Pick<Database, "execute">;

export type RunEventRow = typeof runEvents.$inferSelect;

export type ApprovalRow = typeof approvals.$inferSelect;

export function createDb(url: string) {
  const connectionString = z.url().parse(url);
  return drizzle({ client: new Pool({ connectionString }), schema });
}

async function rowsOf<T extends z.ZodType>(row: T, query: Executor, statement: SQL) {
  const result = await query.execute(statement);
  return z.object({ rows: z.array(row) }).parse(result).rows;
}

async function onlyRow<T extends z.ZodType>(row: T, query: Executor, statement: SQL) {
  const [first] = await rowsOf(row, query, statement);
  if (first === undefined) {
    throw new Error("expected one row, got none");
  }
  return first;
}

export async function withTenant<T>(
  db: Database,
  userId: string,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  const tenantUserId = z.uuid().parse(userId);
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local role delegate_app`);
    await tx.execute(sql`select set_config('app.user_id', ${tenantUserId}, true)`);
    return fn(tx);
  });
}

export const appendRunEventInputSchema = z.strictObject({
  runId: z.uuid(),
  workspaceId: z.uuid(),
  type: z.enum(RUN_EVENT_TYPES),
  payload: z.unknown(),
  stepId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
});

export type AppendRunEventInput = z.input<typeof appendRunEventInputSchema>;

export class RunNotWritableError extends Error {
  override readonly name = "RunNotWritableError";
  constructor(
    readonly runId: string,
    readonly workspaceId: string,
  ) {
    super(`run ${runId} is not writable in workspace ${workspaceId} for this user`);
  }
}

export async function appendRunEvent(
  tx: TenantTx,
  input: AppendRunEventInput,
): Promise<RunEventRow> {
  const event = appendRunEventInputSchema.parse(input);
  const contract = parseRunEvent({
    runId: event.runId,
    seq: 1,
    at: new Date().toISOString(),
    type: event.type,
    payload: event.payload,
    stepId: event.stepId,
    agentId: event.agentId,
  });
  const writable = await tx
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.id, event.runId), eq(runs.workspaceId, event.workspaceId)))
    .for("update");
  if (writable.length === 0) {
    throw new RunNotWritableError(event.runId, event.workspaceId);
  }
  const nextSeq = sql<number>`(select coalesce(max(${runEvents.seq}), 0) + 1 from ${runEvents} where ${runEvents.runId} = ${event.runId})`;
  const [row] = await tx
    .insert(runEvents)
    .values({
      runId: event.runId,
      workspaceId: event.workspaceId,
      type: contract.type,
      payload: contract.payload,
      stepId: contract.stepId ?? null,
      agentId: contract.agentId ?? null,
      seq: nextSeq,
    })
    .returning();
  if (!row) {
    throw new Error(`run_events insert for run ${event.runId} returned no row`);
  }
  return row;
}

export function runEventFromRow(row: RunEventRow): RunEvent {
  return parseRunEvent({
    runId: row.runId,
    seq: row.seq,
    at: row.createdAt.toISOString(),
    type: row.type,
    payload: row.payload,
    ...(row.stepId === null ? {} : { stepId: row.stepId }),
    ...(row.agentId === null ? {} : { agentId: row.agentId }),
  });
}

export const APPROVAL_DECISIONS = ["approved", "rejected"] as const;

export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export async function resolveApproval(
  tx: TenantTx,
  approvalId: string,
  decision: ApprovalDecision,
): Promise<ApprovalRow> {
  const id = z.uuid().parse(approvalId);
  const verdict = z.enum(APPROVAL_DECISIONS).parse(decision);
  await tx.execute(sql`select id from resolve_approval(${id}::uuid, ${verdict})`);
  const [row] = await tx.select().from(approvals).where(eq(approvals.id, id));
  if (!row) {
    throw new Error(`approval ${id} resolved but is not readable`);
  }
  return row;
}

export const recordAuditInputSchema = z.strictObject({
  workspaceId: z.uuid(),
  action: z.string().min(1),
  target: z.string().min(1).optional(),
  decision: z.enum(auditDecision.enumValues),
  policyId: z.uuid().optional(),
  approvalId: z.uuid().optional(),
  details: z.record(z.string(), z.unknown()).default({}),
  actorType: z.enum(auditActorType.enumValues).default("user"),
});

export type RecordAuditInput = z.input<typeof recordAuditInputSchema>;

export async function recordAudit(tx: TenantTx, input: RecordAuditInput): Promise<number> {
  const entry = recordAuditInputSchema.parse(input);
  const row = await onlyRow(
    z.object({ id: z.coerce.number().int().positive() }),
    tx,
    sql`select record_audit(
      ${entry.workspaceId}::uuid,
      ${entry.action},
      ${entry.target ?? null},
      ${entry.decision}::audit_decision,
      ${entry.policyId ?? null}::uuid,
      ${entry.approvalId ?? null}::uuid,
      ${JSON.stringify(entry.details)}::jsonb,
      ${entry.actorType}::audit_actor_type
    ) as id`,
  );
  return row.id;
}

export async function addRunUsage(
  tx: TenantTx,
  runId: string,
  usage: RunTotals,
): Promise<RunTotals> {
  const id = z.uuid().parse(runId);
  const delta = runTotalsSchema.parse(usage);
  const row = await onlyRow(
    z.object({ totals: runTotalsSchema }),
    tx,
    sql`select add_run_usage(
      ${id}::uuid,
      ${delta.inputTokens},
      ${delta.outputTokens},
      ${delta.cacheReadTokens},
      ${delta.cacheWriteTokens},
      ${delta.costMicroUsd}
    ) as totals`,
  );
  return row.totals;
}

export async function visibleUserEmail(tx: TenantTx, userId: string): Promise<string | null> {
  const id = z.uuid().parse(userId);
  const row = await onlyRow(
    z.object({ email: z.string().nullable() }),
    tx,
    sql`select visible_user_email(${id}::uuid) as email`,
  );
  return row.email;
}

export async function purgeExpiredDemoRuns(maintenance: Executor): Promise<number> {
  const row = await onlyRow(
    z.object({ purged: z.coerce.number().int().nonnegative() }),
    maintenance,
    sql`select purge_expired_demo_runs() as purged`,
  );
  return row.purged;
}

export interface GuestWorkspace {
  userId: string;
  workspaceId: string;
}

export async function createGuestWorkspace(db: Database): Promise<GuestWorkspace> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local role delegate_app`);
    const row = await onlyRow(
      z.object({ user_id: z.uuid(), workspace_id: z.uuid() }),
      tx,
      sql`select user_id, workspace_id from create_guest_workspace()`,
    );
    return { userId: row.user_id, workspaceId: row.workspace_id };
  });
}
