import { type RunLessons } from "@delegate/runtime";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withTenant } from "./client";
import { createDbPlaybookStore, listPlaybookVersions, recordHousePlaybook } from "./playbook-store";
import { playbooks, runEvents, workspaces } from "./schema";
import { seedMember, seedUser, seedWorkspaceContent } from "./testing/fixtures";
import { createTestDb, expectDatabaseError, type TestDb } from "./testing/pglite";

function lessons(runId: string, success = 1): RunLessons {
  return {
    runId,
    key: "company-xray",
    outcome: success === 0 ? "failed" : "completed",
    success,
    at: "2026-11-24T10:00:00.000Z",
    reflectedBy: "deterministic",
    lessons: [
      {
        key: "plan_shape:research>read>synthesise",
        kind: "plan_shape",
        polarity: "keep",
        text: "Plan research → read → synthesise (planner plan) completed the run.",
      },
      {
        key: "step_failed:fill_gaps",
        kind: "step_failed",
        polarity: "avoid",
        text: "Step fill_gaps failed.",
        stepId: "fill_gaps",
      },
    ],
  };
}

describe("playbooks table and store", () => {
  let harness: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let member: string;
  let guest: string;
  let outsider: string;
  let team: Awaited<ReturnType<typeof seedWorkspaceContent>>;
  let demo: Awaited<ReturnType<typeof seedWorkspaceContent>>;
  let elsewhere: Awaited<ReturnType<typeof seedWorkspaceContent>>;

  beforeAll(async () => {
    harness = await createTestDb();
    db = harness.db;
    member = (await seedUser(db, "member")).id;
    guest = (await seedUser(db, "guest")).id;
    outsider = (await seedUser(db, "outsider")).id;
    team = await seedWorkspaceContent(db, "team", member);
    await seedMember(db, team.workspace.id, member, "owner");
    demo = await seedWorkspaceContent(db, "demo", guest);
    await seedMember(db, demo.workspace.id, guest, "owner");
    await db
      .update(workspaces)
      .set({ isDemo: true, retentionDays: 7 })
      .where(eq(workspaces.id, demo.workspace.id));
    elsewhere = await seedWorkspaceContent(db, "elsewhere", outsider);
    await seedMember(db, elsewhere.workspace.id, outsider, "owner");
  });

  afterAll(async () => {
    await harness.client.close();
  });

  it("versions a workspace playbook and folds each run once", async () => {
    const store = createDbPlaybookStore(db, { userId: member, workspaceId: team.workspace.id });
    await store.record(lessons("r1"), { house: false });
    await store.record(lessons("r2", 0.5), { house: false });
    await store.record(lessons("r2", 0.5), { house: false });
    const { workspace, house } = await store.read("company-xray");
    expect(house).toBeNull();
    expect(workspace).toMatchObject({ version: 2, runs: 2, scope: "workspace" });
    expect(workspace?.entries.find((entry) => entry.stepId === "fill_gaps")).toMatchObject({
      evidence: 2,
      successSum: 1.5,
    });
  });

  it("keeps one workspace's playbooks invisible to another workspace", async () => {
    const intruder = createDbPlaybookStore(db, {
      userId: outsider,
      workspaceId: team.workspace.id,
    });
    expect((await intruder.read("company-xray")).workspace).toBeNull();
    const visible = await withTenant(db, outsider, (tx) =>
      tx.select({ id: playbooks.id }).from(playbooks),
    );
    expect(visible).toEqual([]);
    await expectDatabaseError(
      intruder.record(lessons("r9"), { house: false }),
      /row-level security/,
    );
  });

  it("never lets the app role write, rewrite or delete house rows directly", async () => {
    await expectDatabaseError(
      withTenant(db, member, (tx) =>
        tx.insert(playbooks).values({
          workspaceId: null,
          scope: "house",
          key: "company-xray",
          version: 1,
          runs: 1,
          content: {},
        }),
      ),
      /row-level security/,
    );
    await expectDatabaseError(
      withTenant(db, member, (tx) =>
        tx.update(playbooks).set({ runs: 99 }).where(eq(playbooks.workspaceId, team.workspace.id)),
      ),
      /permission denied for table playbooks/,
    );
    await expectDatabaseError(
      withTenant(db, member, (tx) =>
        tx.delete(playbooks).where(eq(playbooks.workspaceId, team.workspace.id)),
      ),
      /permission denied for table playbooks/,
    );
  });

  it("refuses house contributions from demo (guest) workspaces and non-members", async () => {
    await expectDatabaseError(
      recordHousePlaybook(db, { userId: guest, workspaceId: demo.workspace.id }, lessons("g1")),
      /demo workspaces never feed the house playbook/,
    );
    await expectDatabaseError(
      recordHousePlaybook(db, { userId: outsider, workspaceId: team.workspace.id }, lessons("o1")),
      /only an owner or admin/,
    );
    const guestStore = createDbPlaybookStore(db, { userId: guest, workspaceId: demo.workspace.id });
    await expectDatabaseError(guestStore.record(lessons("g2"), { house: true }), /demo workspaces/);
    expect((await guestStore.read("company-xray")).workspace?.runs).toBe(1);
    expect((await guestStore.read("company-xray")).house).toBeNull();
  });

  it("records the house playbook for owners of real workspaces and shares it read-only", async () => {
    const owner = createDbPlaybookStore(db, { userId: member, workspaceId: team.workspace.id });
    await owner.record(lessons("h1"), { house: true });
    await owner.record(lessons("h2"), { house: true });
    const stranger = createDbPlaybookStore(db, {
      userId: outsider,
      workspaceId: elsewhere.workspace.id,
    });
    const seen = await stranger.read("company-xray");
    expect(seen.workspace).toBeNull();
    expect(seen.house).toMatchObject({ scope: "house", version: 2, runs: 2 });
    const timeline = await listPlaybookVersions(db, {
      userId: outsider,
      workspaceId: elsewhere.workspace.id,
    });
    expect(timeline.map((row) => `${row.scope}@${row.version}`)).toEqual(
      expect.arrayContaining(["house@1", "house@2"]),
    );
    expect(timeline.every((row) => row.scope === "house")).toBe(true);
  });

  it("rejects a stale house version so concurrent folds cannot overwrite each other", async () => {
    await expectDatabaseError(
      withTenant(db, member, (tx) =>
        tx.execute(
          sql`select record_house_playbook(${team.workspace.id}::uuid, 'company-xray', 2, 1, ${JSON.stringify({ key: "company-xray", scope: "house" })}::jsonb)`,
        ),
      ),
      /is at version 2, not 1/,
    );
  });

  it("accepts playbook.applied in the event log", async () => {
    await db.insert(runEvents).values({
      runId: team.run.id,
      workspaceId: team.workspace.id,
      seq: 2,
      type: "playbook.applied",
      payload: {},
    });
  });
});
