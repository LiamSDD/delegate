import { afterAll, beforeAll, describe, it } from "vitest";

import { withTenant } from "./client";
import { seedMember, seedUser, seedWorkspaceContent } from "./testing/fixtures";
import { createTestDb, expectDatabaseError, type TestDb } from "./testing/pglite";

const appendOnlyTables = ["run_events", "audit_log"] as const;

describe.each(appendOnlyTables)("%s is append-only", (table) => {
  let harness: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let ownerId: string;

  beforeAll(async () => {
    harness = await createTestDb();
    db = harness.db;
    ownerId = (await seedUser(db, "owner")).id;
    const seeded = await seedWorkspaceContent(db, "append", ownerId);
    await seedMember(db, seeded.workspace.id, ownerId, "owner");
  });

  afterAll(async () => {
    await harness.client.close();
  });

  it("denies UPDATE to delegate_app, even for a workspace owner", async () => {
    await expectDatabaseError(
      withTenant(db, ownerId, (tx) => tx.execute(`update ${table} set created_at = now()`)),
      new RegExp(`permission denied for table ${table}`),
    );
  });

  it("denies DELETE to delegate_app", async () => {
    await expectDatabaseError(
      withTenant(db, ownerId, (tx) => tx.execute(`delete from ${table}`)),
      new RegExp(`permission denied for table ${table}`),
    );
  });

  it("denies TRUNCATE to delegate_app", async () => {
    await expectDatabaseError(
      withTenant(db, ownerId, (tx) => tx.execute(`truncate ${table}`)),
      new RegExp(`permission denied for table ${table}`),
    );
  });

  it("raises from the trigger on UPDATE even for the table owner", async () => {
    await expectDatabaseError(
      db.execute(`update ${table} set created_at = now()`),
      new RegExp(`${table} is append-only: UPDATE is not allowed`),
    );
  });

  it("raises from the trigger on DELETE even for the table owner", async () => {
    await expectDatabaseError(
      db.execute(`delete from ${table}`),
      new RegExp(`${table} is append-only: DELETE is not allowed`),
    );
  });

  it("raises from the trigger on TRUNCATE even for the table owner", async () => {
    await expectDatabaseError(
      db.execute(`truncate ${table} cascade`),
      new RegExp(`${table} is append-only: TRUNCATE is not allowed`),
    );
  });
});
