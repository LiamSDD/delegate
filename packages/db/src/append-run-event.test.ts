import { foldRun, parseRunEvent } from "@delegate/runtime";
import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { type AppendRunEventInput, appendRunEvent, runEventFromRow, withTenant } from "./client";
import type { RunEventType } from "./event-types";
import { runEvents, runs } from "./schema";
import { seedMember, seedUser, seedWorkspaceContent } from "./testing/fixtures";
import { createTestDb, expectDatabaseError, rowsOf, type TestDb } from "./testing/pglite";

type EventBody = Omit<AppendRunEventInput, "runId" | "workspaceId">;

describe("appendRunEvent", () => {
  let harness: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let operatorId: string;
  let viewerId: string;
  let outsiderId: string;
  let seeded: Awaited<ReturnType<typeof seedWorkspaceContent>>;
  let foreign: Awaited<ReturnType<typeof seedWorkspaceContent>>;

  beforeAll(async () => {
    harness = await createTestDb();
    db = harness.db;
    operatorId = (await seedUser(db, "operator")).id;
    viewerId = (await seedUser(db, "viewer")).id;
    outsiderId = (await seedUser(db, "outsider")).id;
    seeded = await seedWorkspaceContent(db, "events", operatorId);
    foreign = await seedWorkspaceContent(db, "foreign", outsiderId);
    await seedMember(db, seeded.workspace.id, operatorId, "operator");
    await seedMember(db, seeded.workspace.id, viewerId, "viewer");
    await seedMember(db, foreign.workspace.id, outsiderId, "operator");
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

  const message = (index: number): EventBody => ({
    type: "agent.message",
    stepId: "research",
    agentId: "researcher-1",
    payload: { text: `message ${index}` },
  });

  const append = (
    actor: string,
    runId: string,
    body: EventBody,
    workspaceId = seeded.workspace.id,
  ) => withTenant(db, actor, (tx) => appendRunEvent(tx, { runId, workspaceId, ...body }));

  it("starts at seq 1 and returns the stored row", async () => {
    const run = await freshRun();
    const row = await append(operatorId, run.id, message(0));
    expect(row).toMatchObject({
      runId: run.id,
      seq: 1,
      type: "agent.message",
      stepId: "research",
      agentId: "researcher-1",
      payload: { text: "message 0" },
    });
  });

  it("assigns contiguous seq to 20 appends issued at once (ordering only: PGlite has one connection, so this is not a race test)", async () => {
    const run = await freshRun();
    const appended = await Promise.all(
      Array.from({ length: 20 }, (_, index) => append(operatorId, run.id, message(index))),
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

  it("serialises appends by locking the run row FOR UPDATE, not with a global advisory lock", async () => {
    const run = await freshRun();
    const locks = await withTenant(db, operatorId, async (tx) => {
      await appendRunEvent(tx, { runId: run.id, workspaceId: seeded.workspace.id, ...message(0) });
      const [held] = await rowsOf(
        z.object({
          row_share_on_runs: z.boolean(),
          advisory: z.coerce.number(),
          row_locked_by_me: z.boolean(),
        }),
        tx.execute(sql`
          select
            exists (
              select 1 from pg_locks
              where locktype = 'relation' and relation = 'runs'::regclass
                and mode = 'RowShareLock' and granted and pid = pg_backend_pid()
            ) as row_share_on_runs,
            (select count(*) from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()) as advisory,
            (select xmax::text = pg_current_xact_id()::xid::text from runs where id = ${run.id}) as row_locked_by_me`),
      );
      return held;
    });
    expect(locks).toEqual({ row_share_on_runs: true, advisory: 0, row_locked_by_me: true });
  });

  it("keeps seq independent per run", async () => {
    const first = await freshRun();
    const second = await freshRun();
    const seqs = await withTenant(db, operatorId, async (tx) => {
      const next = (runId: string) =>
        appendRunEvent(tx, { runId, workspaceId: seeded.workspace.id, ...message(0) });
      return [(await next(first.id)).seq, (await next(first.id)).seq, (await next(second.id)).seq];
    });
    expect(seqs).toEqual([1, 2, 1]);
  });

  it("rejects an unknown event type before reaching the database", async () => {
    const run = await freshRun();
    await expect(
      append(operatorId, run.id, { type: "run.exploded" as RunEventType, payload: {} }),
    ).rejects.toThrow(/Invalid option/);
  });

  it("rejects a payload that does not match the runtime contract", async () => {
    const run = await freshRun();
    await expect(
      append(operatorId, run.id, {
        type: "agent.message",
        stepId: "s",
        agentId: "a",
        payload: { text: 1 },
      }),
    ).rejects.toThrow(/text/);
    await expect(append(operatorId, run.id, { type: "step.started", payload: {} })).rejects.toThrow(
      /stepId/,
    );
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

  it("does not let a viewer append, and fails before taking any lock", async () => {
    const run = await freshRun();
    await expect(append(viewerId, run.id, message(0))).rejects.toThrow(/is not writable/);
  });

  it("does not let an outsider lock or append to another tenant's run", async () => {
    await expect(
      append(outsiderId, seeded.run.id, message(0), foreign.workspace.id),
    ).rejects.toThrow(/is not writable/);
    await expect(append(outsiderId, seeded.run.id, message(0))).rejects.toThrow(/is not writable/);
  });

  it("rejects an event whose workspace does not match its run", async () => {
    const otherOwner = (await seedUser(db, "other")).id;
    const other = await seedWorkspaceContent(db, "other", otherOwner);
    await seedMember(db, other.workspace.id, operatorId, "operator");
    const run = await freshRun();
    await expect(append(operatorId, run.id, message(0), other.workspace.id)).rejects.toThrow(
      /is not writable/,
    );
  });

  it("round-trips a realistic event sequence through the runtime fold", async () => {
    const run = await freshRun();
    const actor = { type: "member" as const, id: operatorId };
    const step = "research";
    const sequence: EventBody[] = [
      {
        type: "run.created",
        payload: {
          workspaceId: seeded.workspace.id,
          missionId: "xray",
          input: { company: "Example Ltd" },
          actor,
          budget: { maxTokens: 100_000, maxMicroUsd: 0 },
        },
      },
      {
        type: "plan.proposed",
        payload: {
          version: 1,
          steps: [
            {
              id: step,
              role: "researcher",
              objective: "Map the company's public footprint",
              inputs: [],
              capabilities: ["web.fetch"],
              acceptance: ["At least three cited sources"],
              budgetShare: 1,
            },
          ],
        },
      },
      { type: "plan.approved", payload: { version: 1, approvedBy: actor } },
      { type: "step.started", stepId: step, payload: {} },
      {
        type: "agent.spawned",
        stepId: step,
        agentId: "researcher-1",
        payload: { role: "researcher", modelRole: "worker" },
      },
      {
        type: "tool.called",
        stepId: step,
        agentId: "researcher-1",
        payload: {
          toolCallId: "tc-1",
          tool: "fetch",
          capability: "web.fetch",
          argsSummary: "GET example.com",
        },
      },
      {
        type: "policy.decided",
        stepId: step,
        payload: {
          toolCallId: "tc-1",
          tool: "fetch",
          decision: "allow",
          policyId: "default",
          reason: "Domain allowlisted",
        },
      },
      {
        type: "tool.result",
        stepId: step,
        payload: {
          toolCallId: "tc-1",
          tool: "fetch",
          ok: true,
          summary: "200 OK, 14 kB",
          durationMs: 120,
        },
      },
      {
        type: "usage.updated",
        stepId: step,
        payload: {
          inputTokens: 1200,
          outputTokens: 300,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costMicroUsd: 0,
          provider: "pollinations",
          model: "openai",
        },
      },
      {
        type: "artifact.created",
        stepId: step,
        payload: { artifactId: "art-1", kind: "report", title: "Company X-ray", version: 1 },
      },
      {
        type: "approval.requested",
        stepId: step,
        payload: {
          approvalId: "ap-1",
          policyId: "default",
          reason: "Outbound message",
          summary: "Email the CFO",
        },
      },
      {
        type: "approval.resolved",
        payload: { approvalId: "ap-1", resolution: "rejected", resolvedBy: actor },
      },
      {
        type: "step.completed",
        stepId: step,
        payload: { outcome: "succeeded", summary: "Footprint mapped", artifactIds: ["art-1"] },
      },
      { type: "run.completed", payload: { summary: "X-ray delivered" } },
    ];
    await withTenant(db, operatorId, async (tx) => {
      for (const body of sequence) {
        await appendRunEvent(tx, { runId: run.id, workspaceId: seeded.workspace.id, ...body });
      }
    });
    const rows = await withTenant(db, viewerId, (tx) =>
      tx.select().from(runEvents).where(eq(runEvents.runId, run.id)).orderBy(asc(runEvents.seq)),
    );
    const events = rows.map((row) => parseRunEvent(runEventFromRow(row)));
    expect(events.map((event) => event.type)).toEqual(sequence.map((body) => body.type));
    const state = foldRun(events);
    expect(state).toMatchObject({
      runId: run.id,
      status: "completed",
      workspaceId: seeded.workspace.id,
      missionId: "xray",
      plan: { version: 1, approved: true },
      steps: [
        { id: step, status: "succeeded", servedBy: { provider: "pollinations", model: "openai" } },
      ],
      totals: { inputTokens: 1200, outputTokens: 300, toolCalls: 1, policyDenials: 0 },
      pendingApprovals: [],
      artifacts: { "art-1": { kind: "report", version: 1, stepId: step } },
      summary: "X-ray delivered",
      lastSeq: sequence.length,
    });
  });
});
