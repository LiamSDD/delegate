import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { appendRunEvent, withTenant } from "./client";
import type { RunEventType } from "./event-types";
import { runEvents, runs } from "./schema";
import { seedMember, seedUser, seedWorkspaceContent } from "./testing/fixtures";
import { createTestDb, expectDatabaseError, type TestDb } from "./testing/pglite";

describe("appendRunEvent", () => {
  let harness: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let operatorId: string;
  let viewerId: string;
  let seeded: Awaited<ReturnType<typeof seedWorkspaceContent>>;

  beforeAll(async () => {
    harness = await createTestDb();
    db = harness.db;
    operatorId = (await seedUser(db, "operator")).id;
    viewerId = (await seedUser(db, "viewer")).id;
    seeded = await seedWorkspaceContent(db, "events", operatorId);
    await seedMember(db, seeded.workspace.id, operatorId, "operator");
    await seedMember(db, seeded.workspace.id, viewerId, "viewer");
  });

  afterAll(async () => {
    await harness.client.close();
  });

  async function freshRun() {
    const [run] = await db
      .insert(runs)
      .values({ workspaceId: seeded.workspace.id, mission: "xray", input: {} })
      .returning();
    if (!run) throw new Error("run not created");
    return run;
  }

  it("starts at seq 1 and returns the stored row", async () => {
    const run = await freshRun();
    const row = await withTenant(db, operatorId, (tx) =>
      appendRunEvent(tx, {
        runId: run.id,
        workspaceId: seeded.workspace.id,
        type: "run.created",
        payload: { mission: "xray" },
      }),
    );
    expect(row).toMatchObject({
      runId: run.id,
      seq: 1,
      type: "run.created",
      payload: { mission: "xray" },
    });
  });

  it("assigns contiguous seq under 20 concurrent appends", async () => {
    const run = await freshRun();
    const appended = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        withTenant(db, operatorId, (tx) =>
          appendRunEvent(tx, {
            runId: run.id,
            workspaceId: seeded.workspace.id,
            type: "agent.message",
            payload: { index },
          }),
        ),
      ),
    );
    const expected = Array.from({ length: 20 }, (_, index) => index + 1);
    expect(appended.map((row) => row.seq).sort((a, b) => a - b)).toEqual(expected);
    const stored = await db
      .select({ seq: runEvents.seq })
      .from(runEvents)
      .where(eq(runEvents.runId, run.id))
      .orderBy(asc(runEvents.seq));
    expect(stored.map((row) => row.seq)).toEqual(expected);
  });

  it("keeps seq independent per run", async () => {
    const first = await freshRun();
    const second = await freshRun();
    const seqs = await withTenant(db, operatorId, async (tx) => {
      const append = (runId: string) =>
        appendRunEvent(tx, {
          runId,
          workspaceId: seeded.workspace.id,
          type: "step.started",
          payload: {},
        });
      return [
        (await append(first.id)).seq,
        (await append(first.id)).seq,
        (await append(second.id)).seq,
      ];
    });
    expect(seqs).toEqual([1, 2, 1]);
  });

  it("rejects an unknown event type before reaching the database", async () => {
    const run = await freshRun();
    await expect(
      withTenant(db, operatorId, (tx) =>
        appendRunEvent(tx, {
          runId: run.id,
          workspaceId: seeded.workspace.id,
          type: "run.exploded" as RunEventType,
          payload: {},
        }),
      ),
    ).rejects.toThrow(/Invalid option/);
  });

  it("rejects an unknown event type in the database as well", async () => {
    const run = await freshRun();
    await expectDatabaseError(
      db.insert(runEvents).values({
        runId: run.id,
        workspaceId: seeded.workspace.id,
        seq: 1,
        type: "run.exploded",
      }),
      /run_events_type_known/,
    );
  });

  it("does not let a viewer append", async () => {
    const run = await freshRun();
    await expectDatabaseError(
      withTenant(db, viewerId, (tx) =>
        appendRunEvent(tx, {
          runId: run.id,
          workspaceId: seeded.workspace.id,
          type: "run.created",
          payload: {},
        }),
      ),
      /row-level security/,
    );
  });

  it("rejects an event whose workspace does not match its run", async () => {
    const otherOwner = (await seedUser(db, "other")).id;
    const other = await seedWorkspaceContent(db, "other", otherOwner);
    await seedMember(db, other.workspace.id, operatorId, "operator");
    const run = await freshRun();
    await expectDatabaseError(
      withTenant(db, operatorId, (tx) =>
        appendRunEvent(tx, {
          runId: run.id,
          workspaceId: other.workspace.id,
          type: "run.created",
          payload: {},
        }),
      ),
      /run_events_run_fk/,
    );
  });
});
