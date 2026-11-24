import { count, eq } from "drizzle-orm";
import { TransactionRollbackError } from "drizzle-orm/errors";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { type Database, type TenantTx, withTenant } from "./client";
import {
  approvals,
  artifacts,
  auditLog,
  chunks,
  documents,
  members,
  memories,
  orgs,
  policies,
  runEvents,
  runs,
  users,
  workspaces,
} from "./schema";
import { seedMember, seedUser, seedWorkspaceContent } from "./testing/fixtures";
import { createTestDb, expectDatabaseError, type TestDb } from "./testing/pglite";

type Seeded = Awaited<ReturnType<typeof seedWorkspaceContent>>;

interface TenantTableCase {
  name: string;
  table: PgTable;
  workspaceColumn: AnyPgColumn;
  insertError?: RegExp;
  insertInto: (tx: TenantTx, target: Seeded, actorId: string) => Promise<unknown>;
  update?: (tx: TenantTx, workspaceId: string) => Promise<unknown[]>;
  remove?: (tx: TenantTx, workspaceId: string) => Promise<unknown[]>;
}

const rlsViolation = /row-level security/;

const cases: TenantTableCase[] = [
  {
    name: "workspaces",
    table: workspaces,
    workspaceColumn: workspaces.id,
    insertError: /permission denied for table workspaces/,
    insertInto: (tx, target) =>
      tx.insert(workspaces).values({ orgId: target.org.id, name: "Intruder", slug: "intruder" }),
    update: (tx, workspaceId) =>
      tx
        .update(workspaces)
        .set({ name: "renamed" })
        .where(eq(workspaces.id, workspaceId))
        .returning({ id: workspaces.id }),
  },
  {
    name: "members",
    table: members,
    workspaceColumn: members.workspaceId,
    insertInto: (tx, target, actorId) =>
      tx
        .insert(members)
        .values({ workspaceId: target.workspace.id, userId: actorId, role: "viewer" }),
    update: (tx, workspaceId) =>
      tx
        .update(members)
        .set({ role: "viewer" })
        .where(eq(members.workspaceId, workspaceId))
        .returning({ id: members.id }),
    remove: (tx, workspaceId) =>
      tx.delete(members).where(eq(members.workspaceId, workspaceId)).returning({ id: members.id }),
  },
  {
    name: "runs",
    table: runs,
    workspaceColumn: runs.workspaceId,
    insertInto: (tx, target) =>
      tx.insert(runs).values({ workspaceId: target.workspace.id, mission: "xray", input: {} }),
    update: (tx, workspaceId) =>
      tx
        .update(runs)
        .set({ status: "cancelled" })
        .where(eq(runs.workspaceId, workspaceId))
        .returning({ id: runs.id }),
  },
  {
    name: "run_events",
    table: runEvents,
    workspaceColumn: runEvents.workspaceId,
    insertInto: (tx, target) =>
      tx.insert(runEvents).values({
        runId: target.run.id,
        workspaceId: target.workspace.id,
        seq: 99,
        type: "run.failed",
      }),
  },
  {
    name: "artifacts",
    table: artifacts,
    workspaceColumn: artifacts.workspaceId,
    insertInto: (tx, target) =>
      tx.insert(artifacts).values({
        runId: target.run.id,
        workspaceId: target.workspace.id,
        kind: "report",
        title: "Planted",
        content: {},
      }),
    update: (tx, workspaceId) =>
      tx
        .update(artifacts)
        .set({ title: "tampered" })
        .where(eq(artifacts.workspaceId, workspaceId))
        .returning({ id: artifacts.id }),
  },
  {
    name: "approvals",
    table: approvals,
    workspaceColumn: approvals.workspaceId,
    insertInto: (tx, target) =>
      tx.insert(approvals).values({
        runId: target.run.id,
        workspaceId: target.workspace.id,
        stepId: "planted",
        action: {},
      }),
    update: (tx, workspaceId) =>
      tx
        .update(approvals)
        .set({ status: "approved", resolvedAt: new Date() })
        .where(eq(approvals.workspaceId, workspaceId))
        .returning({ id: approvals.id }),
  },
  {
    name: "audit_log",
    table: auditLog,
    workspaceColumn: auditLog.workspaceId,
    insertInto: (tx, target, actorId) =>
      tx.insert(auditLog).values({
        workspaceId: target.workspace.id,
        actorType: "user",
        actorId,
        action: "planted",
        decision: "allow",
      }),
  },
  {
    name: "policies",
    table: policies,
    workspaceColumn: policies.workspaceId,
    insertInto: (tx, target) =>
      tx
        .insert(policies)
        .values({ workspaceId: target.workspace.id, name: "planted", definition: {} }),
    update: (tx, workspaceId) =>
      tx
        .update(policies)
        .set({ enabled: false })
        .where(eq(policies.workspaceId, workspaceId))
        .returning({ id: policies.id }),
    remove: (tx, workspaceId) =>
      tx
        .delete(policies)
        .where(eq(policies.workspaceId, workspaceId))
        .returning({ id: policies.id }),
  },
  {
    name: "memories",
    table: memories,
    workspaceColumn: memories.workspaceId,
    insertInto: (tx, target) =>
      tx.insert(memories).values({
        workspaceId: target.workspace.id,
        key: "planted",
        value: {},
        createdByAgent: "intruder",
      }),
    update: (tx, workspaceId) =>
      tx
        .update(memories)
        .set({ value: { tampered: true } })
        .where(eq(memories.workspaceId, workspaceId))
        .returning({ id: memories.id }),
    remove: (tx, workspaceId) =>
      tx
        .delete(memories)
        .where(eq(memories.workspaceId, workspaceId))
        .returning({ id: memories.id }),
  },
  {
    name: "documents",
    table: documents,
    workspaceColumn: documents.workspaceId,
    insertInto: (tx, target) =>
      tx
        .insert(documents)
        .values({ workspaceId: target.workspace.id, title: "Planted", contentHash: "x" }),
    update: (tx, workspaceId) =>
      tx
        .update(documents)
        .set({ classification: "public" })
        .where(eq(documents.workspaceId, workspaceId))
        .returning({ id: documents.id }),
    remove: (tx, workspaceId) =>
      tx
        .delete(documents)
        .where(eq(documents.workspaceId, workspaceId))
        .returning({ id: documents.id }),
  },
  {
    name: "chunks",
    table: chunks,
    workspaceColumn: chunks.workspaceId,
    insertInto: (tx, target) =>
      tx.insert(chunks).values({
        documentId: target.document.id,
        workspaceId: target.workspace.id,
        ordinal: 99,
        text: "planted",
      }),
    update: (tx, workspaceId) =>
      tx
        .update(chunks)
        .set({ text: "tampered" })
        .where(eq(chunks.workspaceId, workspaceId))
        .returning({ id: chunks.id }),
    remove: (tx, workspaceId) =>
      tx.delete(chunks).where(eq(chunks.workspaceId, workspaceId)).returning({ id: chunks.id }),
  },
];

async function countIn(tx: Database, table: PgTable, column: AnyPgColumn, workspaceId: string) {
  const [row] = await tx.select({ n: count() }).from(table).where(eq(column, workspaceId));
  return row?.n ?? 0;
}

describe("tenant isolation under delegate_app", () => {
  let harness: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let alice: Awaited<ReturnType<typeof seedUser>>;
  let bob: Awaited<ReturnType<typeof seedUser>>;
  let mine: Seeded;
  let theirs: Seeded;

  beforeAll(async () => {
    harness = await createTestDb();
    db = harness.db;
    alice = await seedUser(db, "alice");
    bob = await seedUser(db, "bob");
    mine = await seedWorkspaceContent(db, "one", alice.id);
    theirs = await seedWorkspaceContent(db, "two", bob.id);
    await seedMember(db, mine.workspace.id, alice.id, "owner");
    await seedMember(db, theirs.workspace.id, bob.id, "owner");
  });

  afterAll(async () => {
    await harness.client.close();
  });

  it("runs tenant queries as delegate_app with the user id set", async () => {
    const identity = await withTenant(db, alice.id, async (tx) => {
      const result = await tx.execute(
        "select current_user as role, current_setting('app.user_id', true) as user_id",
      );
      return z
        .object({ rows: z.array(z.object({ role: z.string(), user_id: z.string() })) })
        .parse(result).rows[0];
    });
    expect(identity).toEqual({ role: "delegate_app", user_id: alice.id });
  });

  it("rejects a malformed user id before touching the database", async () => {
    await expect(withTenant(db, "not-a-uuid", () => Promise.resolve(null))).rejects.toThrow();
  });

  it("sees nothing without a user id", async () => {
    const visible = await db.transaction(async (tx) => {
      await tx.execute("set local role delegate_app");
      return countIn(tx, runs, runs.workspaceId, mine.workspace.id);
    });
    expect(visible).toBe(0);
  });

  describe.each(cases)("$name", (tableCase) => {
    it("is visible in the member's own workspace", async () => {
      const visible = await withTenant(db, alice.id, (tx) =>
        countIn(tx, tableCase.table, tableCase.workspaceColumn, mine.workspace.id),
      );
      expect(visible).toBeGreaterThan(0);
    });

    it("returns zero rows from another workspace", async () => {
      const total = await countIn(
        db,
        tableCase.table,
        tableCase.workspaceColumn,
        theirs.workspace.id,
      );
      expect(total).toBeGreaterThan(0);
      const visible = await withTenant(db, alice.id, (tx) =>
        countIn(tx, tableCase.table, tableCase.workspaceColumn, theirs.workspace.id),
      );
      expect(visible).toBe(0);
    });

    it("rejects inserts into another workspace", async () => {
      await expectDatabaseError(
        withTenant(db, alice.id, (tx) => tableCase.insertInto(tx, theirs, alice.id)),
        tableCase.insertError ?? rlsViolation,
      );
    });

    const { update, remove } = tableCase;

    if (update) {
      it("updates zero rows in another workspace and some in its own", async () => {
        const foreign = await withTenant(db, alice.id, (tx) => update(tx, theirs.workspace.id));
        expect(foreign).toHaveLength(0);
        let ownRows = 0;
        await expect(
          withTenant(db, alice.id, async (tx) => {
            ownRows = (await update(tx, mine.workspace.id)).length;
            tx.rollback();
          }),
        ).rejects.toBeInstanceOf(TransactionRollbackError);
        expect(ownRows).toBeGreaterThan(0);
      });
    }

    if (remove) {
      it("deletes zero rows in another workspace", async () => {
        const removed = await withTenant(db, alice.id, (tx) => remove(tx, theirs.workspace.id));
        expect(removed).toHaveLength(0);
      });
    }
  });

  it("hides users and orgs that share no workspace", async () => {
    const seen = await withTenant(db, alice.id, async (tx) => ({
      users: (await tx.select({ id: users.id }).from(users)).map((row) => row.id),
      orgs: (await tx.select({ id: orgs.id }).from(orgs)).map((row) => row.id),
    }));
    expect(seen.users).toEqual([alice.id]);
    expect(seen.orgs).toEqual([mine.org.id]);
  });
});
