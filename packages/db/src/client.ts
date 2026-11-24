import { Pool } from "@neondatabase/serverless";
import { type ExtractTablesWithRelations, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-serverless";
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import { z } from "zod";

import { RUN_EVENT_TYPES } from "./event-types";
import * as schema from "./schema";
import { runEvents } from "./schema";

export type DbSchema = typeof schema;

export type Database = PgDatabase<PgQueryResultHKT, DbSchema>;

export type TenantTx = PgTransaction<
  PgQueryResultHKT,
  DbSchema,
  ExtractTablesWithRelations<DbSchema>
>;

export type RunEventRow = typeof runEvents.$inferSelect;

export function createDb(url: string) {
  const connectionString = z.url().parse(url);
  return drizzle({ client: new Pool({ connectionString }), schema });
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
});

export type AppendRunEventInput = z.input<typeof appendRunEventInputSchema>;

export async function appendRunEvent(
  tx: TenantTx,
  input: AppendRunEventInput,
): Promise<RunEventRow> {
  const event = appendRunEventInputSchema.parse(input);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${event.runId}, 0))`);
  const nextSeq = sql<number>`(select coalesce(max(${runEvents.seq}), 0) + 1 from ${runEvents} where ${runEvents.runId} = ${event.runId})`;
  const [row] = await tx
    .insert(runEvents)
    .values({
      runId: event.runId,
      workspaceId: event.workspaceId,
      type: event.type,
      payload: event.payload ?? {},
      seq: nextSeq,
    })
    .returning();
  if (!row) {
    throw new Error(`run_events insert for run ${event.runId} returned no row`);
  }
  return row;
}
