import { count, eq, inArray, sql } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { purgeExpiredDemoRuns, withTenant } from "./client";
import {
  approvals,
  artifacts,
  auditLog,
  memories,
  orgs,
  runEvents,
  runs,
  workspaces,
} from "./schema";
import { seedMember, seedUser } from "./testing/fixtures";
import { asSessionRole, createTestDb, expectDatabaseError, type TestDb } from "./testing/pglite";

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

describe("demo retention purge", () => {
  let harness: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let ownerId: string;
  let demoId: string;
  let prodId: string;
  const runIds = { expired: "", fork: "", recent: "", prodOld: "" };
  const auditIds = { oldDemo: 0, recentDemoOnExpiredApproval: 0, recentDemo: 0, oldProd: 0 };

  async function insertRun(workspaceId: string, createdAt: Date, parentRunId?: string) {
    const [run] = await db
      .insert(runs)
      .values({
        workspaceId,
        mission: "xray",
        input: {},
        createdAt,
        ...(parentRunId === undefined ? {} : { parentRunId, forkedFromSeq: 1 }),
      })
      .returning();
    if (!run) throw new Error("run not created");
    await db.insert(runEvents).values({ runId: run.id, workspaceId, seq: 1, type: "run.created" });
    await db
      .insert(artifacts)
      .values({ runId: run.id, workspaceId, kind: "report", title: "r", content: {} });
    await db
      .insert(memories)
      .values({ runId: run.id, workspaceId, key: "k", value: {}, createdByAgent: "researcher" });
    const [approval] = await db
      .insert(approvals)
      .values({ runId: run.id, workspaceId, stepId: "s", action: {} })
      .returning();
    if (!approval) throw new Error("approval not created");
    return { run, approval };
  }

  async function insertAudit(workspaceId: string, createdAt: Date, approvalId?: string) {
    const [row] = await db
      .insert(auditLog)
      .values({
        workspaceId,
        actorType: "system",
        action: "probe",
        decision: "n/a",
        createdAt,
        ...(approvalId === undefined ? {} : { approvalId }),
      })
      .returning({ id: auditLog.id });
    if (!row) throw new Error("audit row not created");
    return row.id;
  }

  beforeAll(async () => {
    harness = await createTestDb();
    db = harness.db;
    ownerId = (await seedUser(db, "owner")).id;
    const [org] = await db
      .insert(orgs)
      .values({ name: "Retention", slug: "retention" })
      .returning();
    if (!org) throw new Error("org not created");
    const [demo] = await db
      .insert(workspaces)
      .values({ orgId: org.id, name: "Demo", slug: "demo", isDemo: true })
      .returning();
    const [prod] = await db
      .insert(workspaces)
      .values({ orgId: org.id, name: "Prod", slug: "prod" })
      .returning();
    if (!demo || !prod) throw new Error("workspace not created");
    demoId = demo.id;
    prodId = prod.id;
    await seedMember(db, demoId, ownerId, "owner");
    await seedMember(db, prodId, ownerId, "owner");

    const expired = await insertRun(demoId, daysAgo(8));
    const fork = await insertRun(demoId, daysAgo(1), expired.run.id);
    const recent = await insertRun(demoId, daysAgo(2));
    const prodOld = await insertRun(prodId, daysAgo(400));
    runIds.expired = expired.run.id;
    runIds.fork = fork.run.id;
    runIds.recent = recent.run.id;
    runIds.prodOld = prodOld.run.id;

    auditIds.oldDemo = await insertAudit(demoId, daysAgo(9));
    auditIds.recentDemoOnExpiredApproval = await insertAudit(demoId, daysAgo(1), fork.approval.id);
    auditIds.recentDemo = await insertAudit(demoId, daysAgo(1), recent.approval.id);
    auditIds.oldProd = await insertAudit(prodId, daysAgo(400), prodOld.approval.id);
  });

  afterAll(async () => {
    await harness.client.close();
  });

  async function remaining(table: PgTable, column: AnyPgColumn, ids: string[]) {
    const [row] = await db.select({ n: count() }).from(table).where(inArray(column, ids));
    return row?.n ?? 0;
  }

  it("is not callable by delegate_app", async () => {
    await expectDatabaseError(
      withTenant(db, ownerId, (tx) => tx.execute(sql`select purge_expired_demo_runs()`)),
      /permission denied for function purge_expired_demo_runs/,
    );
  });

  it("is not bypassed by a session that sets the purge setting itself", async () => {
    await expectDatabaseError(
      db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('delegate.retention_purge', 'on', true)`);
        await tx.execute(sql`delete from run_events where run_id = ${runIds.expired}`);
      }),
      /run_events is append-only: DELETE is not allowed/,
    );
    await expectDatabaseError(
      db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('delegate.retention_purge', 'on', true)`);
        await tx.execute(sql`delete from audit_log where id = ${auditIds.oldDemo}`);
      }),
      /audit_log is append-only: DELETE is not allowed/,
    );
  });

  it("does not let the table owner delete a run outside the purge path", async () => {
    await expectDatabaseError(
      db.delete(runs).where(eq(runs.id, runIds.recent)),
      /append-only: DELETE is not allowed/,
    );
  });

  it("refuses to delete a workspace that still has events or audit rows", async () => {
    await expectDatabaseError(
      db.delete(workspaces).where(eq(workspaces.id, prodId)),
      /(run_events|audit_log) is append-only: DELETE is not allowed/,
    );
  });

  it("deletes expired demo runs, their forks and everything hanging off them", async () => {
    await db.execute(sql`create role cron_login login noinherit`);
    await db.execute(sql`grant delegate_maintenance to cron_login`);
    const purged = await asSessionRole(db, "cron_login", () =>
      db.transaction(async (tx) => {
        await tx.execute(sql`set local role delegate_maintenance`);
        return purgeExpiredDemoRuns(tx);
      }),
    );
    expect(purged).toBe(2);
    const gone = [runIds.expired, runIds.fork];
    expect(await remaining(runs, runs.id, gone)).toBe(0);
    expect(await remaining(runEvents, runEvents.runId, gone)).toBe(0);
    expect(await remaining(artifacts, artifacts.runId, gone)).toBe(0);
    expect(await remaining(approvals, approvals.runId, gone)).toBe(0);
    expect(await remaining(memories, memories.runId, gone)).toBe(0);
    const kept = [runIds.recent, runIds.prodOld];
    expect(await remaining(runs, runs.id, kept)).toBe(2);
    expect(await remaining(runEvents, runEvents.runId, kept)).toBe(2);
  });

  it("purges demo audit rows past retention or tied to purged approvals, and keeps the rest", async () => {
    const rows = await db.select({ id: auditLog.id }).from(auditLog);
    const present = new Set(rows.map((row) => row.id));
    expect(present.has(auditIds.oldDemo)).toBe(false);
    expect(present.has(auditIds.recentDemoOnExpiredApproval)).toBe(false);
    expect(present.has(auditIds.recentDemo)).toBe(true);
    expect(present.has(auditIds.oldProd)).toBe(true);
  });

  it("leaves the append-only guard armed after it returns", async () => {
    await expectDatabaseError(
      db.transaction(async (tx) => {
        await tx.execute(sql`select purge_expired_demo_runs()`);
        await tx.execute(sql`delete from run_events where run_id = ${runIds.recent}`);
      }),
      /run_events is append-only: DELETE is not allowed/,
    );
  });
});
