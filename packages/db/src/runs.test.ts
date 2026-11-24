import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addRunUsage, withTenant } from "./client";
import { emptyRunTotals } from "./run-json";
import { runs } from "./schema";
import { seedMember, seedUser, seedWorkspaceContent } from "./testing/fixtures";
import { createTestDb, expectDatabaseError, type TestDb } from "./testing/pglite";

const usage = {
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 5,
  cacheWriteTokens: 1,
  costMicroUsd: 300,
};

describe("runs", () => {
  let harness: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let seeded: Awaited<ReturnType<typeof seedWorkspaceContent>>;
  let theirs: Awaited<ReturnType<typeof seedWorkspaceContent>>;
  const ids = { owner: "", operator: "", viewer: "", stranger: "" };

  beforeAll(async () => {
    harness = await createTestDb();
    db = harness.db;
    for (const name of Object.keys(ids) as (keyof typeof ids)[]) {
      ids[name] = (await seedUser(db, name)).id;
    }
    seeded = await seedWorkspaceContent(db, "runs", ids.owner);
    theirs = await seedWorkspaceContent(db, "theirs", ids.stranger);
    await seedMember(db, seeded.workspace.id, ids.owner, "owner");
    await seedMember(db, seeded.workspace.id, ids.operator, "operator");
    await seedMember(db, seeded.workspace.id, ids.viewer, "viewer");
    await seedMember(db, theirs.workspace.id, ids.stranger, "owner");
  });

  afterAll(async () => {
    await harness.client.close();
  });

  async function freshRun() {
    const [run] = await withTenant(db, ids.operator, (tx) =>
      tx
        .insert(runs)
        .values({
          workspaceId: seeded.workspace.id,
          mission: "xray",
          input: {},
          budget: { maxTokens: 1000, maxMicroUsd: 5000 },
        })
        .returning(),
    );
    if (!run) throw new Error("run not created");
    return run;
  }

  it("records the caller as creator when created_by is omitted", async () => {
    const run = await freshRun();
    expect(run.createdBy).toBe(ids.operator);
    expect(run.status).toBe("planning");
    expect(run.totals).toEqual(emptyRunTotals);
  });

  it("rejects a run attributed to someone else", async () => {
    await expectDatabaseError(
      withTenant(db, ids.operator, (tx) =>
        tx.insert(runs).values({
          workspaceId: seeded.workspace.id,
          mission: "xray",
          input: {},
          createdBy: ids.owner,
        }),
      ),
      /row-level security/,
    );
  });

  it("rejects a run created with non-zero totals", async () => {
    await expectDatabaseError(
      withTenant(db, ids.operator, (tx) =>
        tx.insert(runs).values({
          workspaceId: seeded.workspace.id,
          mission: "xray",
          input: {},
          totals: { ...emptyRunTotals, costMicroUsd: -5 },
        }),
      ),
      /row-level security/,
    );
  });

  it("lets an operator move the lifecycle columns", async () => {
    const run = await freshRun();
    const [updated] = await withTenant(db, ids.operator, (tx) =>
      tx
        .update(runs)
        .set({ status: "running", startedAt: new Date() })
        .where(eq(runs.id, run.id))
        .returning({ status: runs.status }),
    );
    expect(updated?.status).toBe("running");
  });

  it.each([
    ["budget", { budget: { maxTokens: 10_000_000 } }],
    ["totals", { totals: emptyRunTotals }],
    ["created_by", { createdBy: "00000000-0000-4000-8000-000000000001" }],
    ["mission", { mission: "other" }],
  ] as const)("does not let an operator rewrite %s", async (_column, change) => {
    const run = await freshRun();
    await expectDatabaseError(
      withTenant(db, ids.operator, (tx) => tx.update(runs).set(change).where(eq(runs.id, run.id))),
      /permission denied for table runs/,
    );
  });

  it("keeps the budget immutable even for the table owner", async () => {
    const run = await freshRun();
    await expectDatabaseError(
      db
        .update(runs)
        .set({ budget: { maxTokens: 1 } })
        .where(eq(runs.id, run.id)),
      /runs\.budget is immutable/,
    );
  });

  it("accumulates usage monotonically through add_run_usage", async () => {
    const run = await freshRun();
    await withTenant(db, ids.operator, (tx) => addRunUsage(tx, run.id, usage));
    const totals = await withTenant(db, ids.operator, (tx) => addRunUsage(tx, run.id, usage));
    expect(totals).toEqual({
      inputTokens: 200,
      outputTokens: 40,
      cacheReadTokens: 10,
      cacheWriteTokens: 2,
      costMicroUsd: 600,
    });
  });

  it("rejects negative usage", async () => {
    const run = await freshRun();
    await expectDatabaseError(
      withTenant(db, ids.operator, (tx) =>
        tx.execute(sql`select add_run_usage(${run.id}::uuid, 0, 0, 0, 0, -1)`),
      ),
      /usage must be non-negative/,
    );
  });

  it("does not let a viewer or a stranger add usage", async () => {
    const run = await freshRun();
    await expectDatabaseError(
      withTenant(db, ids.viewer, (tx) => addRunUsage(tx, run.id, usage)),
      /run not found/,
    );
    await expectDatabaseError(
      withTenant(db, ids.stranger, (tx) => addRunUsage(tx, run.id, usage)),
      /run not found/,
    );
  });

  it("refuses to decrease totals even for the table owner", async () => {
    const run = await freshRun();
    await withTenant(db, ids.operator, (tx) => addRunUsage(tx, run.id, usage));
    await expectDatabaseError(
      db.update(runs).set({ totals: emptyRunTotals }).where(eq(runs.id, run.id)),
      /runs\.totals cannot decrease/,
    );
  });
});
