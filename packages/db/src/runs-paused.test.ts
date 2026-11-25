import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withTenant } from "./client";
import { runs, workspaceSettings } from "./schema";
import { seedMember, seedUser, seedWorkspaceContent } from "./testing/fixtures";
import {
  asAppLogin,
  createTestDb,
  databaseErrorMessage,
  expectDatabaseError,
  type TestDb,
} from "./testing/pglite";

const PAUSED = /new runs are paused for workspace/;

function sqlState(error: unknown): string | null {
  let current: unknown = error;
  while (current instanceof Error) {
    const code = (current as Error & { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = current.cause;
  }
  return null;
}

describe("pausing new runs for a workspace", () => {
  let harness: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  const ids = { owner: "", operator: "", viewer: "", other: "" };
  let paused: Awaited<ReturnType<typeof seedWorkspaceContent>>;
  let open: Awaited<ReturnType<typeof seedWorkspaceContent>>;

  const insertRun = (userId: string, workspaceId: string, parentRunId?: string) =>
    asAppLogin(db, () =>
      withTenant(db, userId, (tx) =>
        tx
          .insert(runs)
          .values({
            workspaceId,
            mission: "xray",
            input: {},
            ...(parentRunId === undefined ? {} : { parentRunId, forkedFromSeq: 1 }),
          })
          .returning({ id: runs.id }),
      ),
    );

  const setPaused = (userId: string, workspaceId: string, at: Date | null) =>
    asAppLogin(db, () =>
      withTenant(db, userId, (tx) =>
        tx
          .insert(workspaceSettings)
          .values({ workspaceId, runsPausedAt: at })
          .onConflictDoUpdate({
            target: workspaceSettings.workspaceId,
            set: { runsPausedAt: at, updatedAt: sql`now()` },
          }),
      ),
    );

  beforeAll(async () => {
    harness = await createTestDb();
    db = harness.db;
    for (const name of Object.keys(ids) as (keyof typeof ids)[])
      ids[name] = (await seedUser(db, name)).id;
    paused = await seedWorkspaceContent(db, "paused", ids.owner);
    open = await seedWorkspaceContent(db, "open", ids.other);
    await seedMember(db, paused.workspace.id, ids.owner, "owner");
    await seedMember(db, paused.workspace.id, ids.operator, "operator");
    await seedMember(db, paused.workspace.id, ids.viewer, "viewer");
    await seedMember(db, open.workspace.id, ids.other, "owner");
  });

  afterAll(async () => {
    await harness.client.close();
  });

  it("lets runs start while no settings row exists", async () => {
    const [run] = await insertRun(ids.operator, paused.workspace.id);
    expect(run?.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("only lets an owner or admin flip the switch", async () => {
    await expectDatabaseError(
      setPaused(ids.operator, paused.workspace.id, new Date()),
      /row-level security/,
    );
    await expectDatabaseError(
      setPaused(ids.viewer, paused.workspace.id, new Date()),
      /row-level security/,
    );
    await expectDatabaseError(
      setPaused(ids.other, paused.workspace.id, new Date()),
      /row-level security/,
    );
  });

  it("refuses every new run in a paused workspace with its own SQLSTATE", async () => {
    await setPaused(ids.owner, paused.workspace.id, new Date());
    let failure: unknown;
    try {
      await insertRun(ids.operator, paused.workspace.id);
    } catch (error: unknown) {
      failure = error;
    }
    expect(databaseErrorMessage(failure)).toMatch(PAUSED);
    expect(sqlState(failure)).toBe("DG001");
    await expectDatabaseError(insertRun(ids.owner, paused.workspace.id), PAUSED);
    await expectDatabaseError(insertRun(ids.owner, paused.workspace.id, paused.run.id), PAUSED);
  });

  it("applies to the table owner as well, so no code path can skip it", async () => {
    await expectDatabaseError(
      db.insert(runs).values({ workspaceId: paused.workspace.id, mission: "xray", input: {} }),
      PAUSED,
    );
  });

  it("does not touch existing runs or other workspaces", async () => {
    await withTenant(db, ids.operator, (tx) =>
      tx.update(runs).set({ status: "running" }).where(eq(runs.id, paused.run.id)),
    );
    const [run] = await insertRun(ids.other, open.workspace.id);
    expect(run?.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("lets runs start again once resumed", async () => {
    await setPaused(ids.owner, paused.workspace.id, null);
    const [run] = await insertRun(ids.operator, paused.workspace.id);
    expect(run?.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
