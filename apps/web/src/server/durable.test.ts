import { approvals, withTenant } from "@delegate/db";
import { foldRun, type PlanStep, type RunEvent } from "@delegate/runtime";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HANDOFF_POLICY_ID, MAX_RESUMES, RESUME_POLICY_ID } from "@/lib/runs/resume";

import { type ApiDeps, handlePlanDecision } from "./api";
import { type AppDatabase, createPgliteAppDatabase } from "./db";
import { reviveOrSweep } from "./durable";
import { executeRun } from "./execute-run";
import { createDbLease } from "./leases";
import type { MissionRunner } from "./mission-runner";
import { createRunRegistry } from "./run-registry";
import { createRunRecord, getRunRecord, readAllEvents, type RunContext } from "./runs";
import { createRateLimiter, type GuestSession, resolveGuest, signSession } from "./session";

const ORIGIN = "http://localhost:3000";
const secret = "s".repeat(32);

let app: AppDatabase;

beforeAll(async () => {
  app = await createPgliteAppDatabase();
});

afterAll(async () => {
  await app.close();
});

const steps: PlanStep[] = [
  {
    id: "map",
    role: "researcher",
    objective: "Map the site",
    inputs: [],
    capabilities: ["fetch"],
    acceptance: ["ok"],
    budgetShare: 0.5,
  },
];

interface Calls {
  starts: number;
  resumes: number;
}

function planningRunner(calls: Calls): MissionRunner {
  return async ({ emit, awaitPlanApproval, resumeFrom, signal }) => {
    if (resumeFrom === undefined) calls.starts += 1;
    else calls.resumes += 1;
    const plan = resumeFrom === undefined ? null : foldRun(resumeFrom).plan;
    if (plan === null) await emit({ type: "plan.proposed", payload: { version: 1, steps } });
    if (plan?.approved !== true) {
      const decision = await awaitPlanApproval({ version: 1, steps, kind: "initial" }, signal);
      if (decision.decision === "rejected") {
        await emit({
          type: "run.failed",
          payload: { error: { code: "plan_rejected", message: "rejected" } },
        });
        return { status: "failed" };
      }
      await emit({
        type: "plan.approved",
        payload: { version: 1, approvedBy: { type: "guest", id: "reviewer" } },
      });
    }
    await emit({ type: "run.completed", payload: { summary: "done" } });
    return { status: "completed" };
  };
}

function slowRunner(calls: Calls, slices: number): MissionRunner {
  return async ({ emit, resumeFrom, signal }) => {
    if (resumeFrom === undefined) calls.starts += 1;
    else calls.resumes += 1;
    if (calls.starts + calls.resumes <= slices) {
      await emit({
        type: "usage.updated",
        payload: {
          inputTokens: 10,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costMicroUsd: 0,
          provider: "scripted",
          model: "scripted",
        },
      });
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            resolve();
          },
          { once: true },
        );
      });
      return { status: "failed" };
    }
    await emit({ type: "run.completed", payload: { summary: "done" } });
    return { status: "completed" };
  };
}

interface Harness {
  deps: ApiDeps;
  tasks: (() => Promise<void>)[];
  session: GuestSession;
  ctx: RunContext;
}

async function harness(run: MissionRunner, now?: () => Date): Promise<Harness> {
  const tasks: (() => Promise<void>)[] = [];
  const { session } = await resolveGuest(app, undefined, secret);
  const { runId } = await createRunRecord(app, session, {
    missionId: "automation-audit",
    input: { url: "https://acme.test/" },
    execution: "live",
  });
  return {
    tasks,
    session,
    ctx: { runId, workspaceId: session.workspaceId, userId: session.userId },
    deps: {
      app: () => Promise.resolve(app),
      secret: () => secret,
      guestLimiter: createRateLimiter({ limit: 20, windowMs: 3_600_000 }),
      ipLimiter: createRateLimiter({ limit: 50, windowMs: 3_600_000 }),
      registry: createRunRegistry(),
      runner: () => ({ execution: "live", run }),
      schedule: (task) => {
        tasks.push(task);
      },
      production: false,
      ...(now === undefined ? {} : { now }),
    },
  };
}

async function drain(h: Harness, limit = 20): Promise<void> {
  for (let index = 0; index < limit && h.tasks.length > 0; index += 1) {
    const task = h.tasks.shift();
    if (task !== undefined) await task();
  }
}

async function revive(h: Harness, deps: ApiDeps = h.deps) {
  const record = await getRunRecord(app, h.session.userId, h.ctx.runId);
  if (record === null) throw new Error("no run");
  return reviveOrSweep(app, h.session.userId, record, deps);
}

function markers(events: readonly RunEvent[], policyId: string): number {
  return events.filter(
    (event) => event.type === "policy.decided" && event.payload.policyId === policyId,
  ).length;
}

function approve(h: Harness): Request {
  return new Request(`${ORIGIN}/api/runs/${h.ctx.runId}/plan`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      host: "localhost:3000",
      cookie: `delegate_session=${signSession(h.session, secret)}`,
    },
    body: JSON.stringify({ decision: "approved" }),
  });
}

describe("waiting for a plan decision", () => {
  it("parks without a worker, is never resumed as lost, and continues once approved", async () => {
    const calls = { starts: 0, resumes: 0 };
    const h = await harness(planningRunner(calls));
    await executeRun({
      app,
      ctx: h.ctx,
      missionId: "automation-audit",
      input: { url: "https://acme.test/" },
      runner: planningRunner(calls),
      registry: h.deps.registry,
      lease: createDbLease(app, h.ctx),
      planWait: { pollMs: 5, inlineWaitMs: 30 },
    });
    const parked = await getRunRecord(app, h.session.userId, h.ctx.runId);
    expect(parked?.status).toBe("awaiting_plan_approval");
    expect(parked?.leaseOwner).toBeNull();

    for (const minutes of [1, 4, 9]) {
      const later = { ...h.deps, now: () => new Date(Date.now() + minutes * 60_000) };
      const after = await revive(h, later);
      expect(after?.status).toBe("awaiting_plan_approval");
    }
    expect(h.tasks).toHaveLength(0);

    const decided = await handlePlanDecision(approve(h), h.ctx.runId, h.deps);
    expect(decided.status).toBe(200);
    await drain(h);

    const events = await readAllEvents(app, h.session.userId, h.ctx.runId);
    expect(foldRun(events).status).toBe("completed");
    expect(markers(events, RESUME_POLICY_ID)).toBe(0);
    expect(calls).toEqual({ starts: 1, resumes: 1 });
    const rows = await withTenant(app.db, h.session.userId, (tx) =>
      tx.select().from(approvals).where(eq(approvals.runId, h.ctx.runId)),
    );
    expect(rows).toHaveLength(1);
  });

  it("times a parked plan out into a rejection on the first read after the deadline", async () => {
    const calls = { starts: 0, resumes: 0 };
    const h = await harness(planningRunner(calls));
    await executeRun({
      app,
      ctx: h.ctx,
      missionId: "automation-audit",
      input: { url: "https://acme.test/" },
      runner: planningRunner(calls),
      registry: h.deps.registry,
      lease: createDbLease(app, h.ctx),
      planWait: { pollMs: 5, inlineWaitMs: 30 },
    });
    await revive(h, { ...h.deps, now: () => new Date(Date.now() + 11 * 60_000) });
    await drain(h);
    const events = await readAllEvents(app, h.session.userId, h.ctx.runId);
    expect(foldRun(events).error?.code).toBe("plan_rejected");
    expect(markers(events, RESUME_POLICY_ID)).toBe(0);
  });
});

describe("planned hand-offs", () => {
  it("hands off before the invocation ends and continues on the next read, more times than resumes allow", async () => {
    const calls = { starts: 0, resumes: 0 };
    const slices = MAX_RESUMES + 2;
    const runner = slowRunner(calls, slices);
    const h = await harness(runner);
    const slice = () => ({
      startedAt: Date.now(),
      budgetMs: 300_000,
      handoffAt: Date.now() + 40,
      minMs: 10,
    });
    await executeRun({
      app,
      ctx: h.ctx,
      missionId: "automation-audit",
      input: { url: "https://acme.test/" },
      runner,
      registry: h.deps.registry,
      lease: createDbLease(app, h.ctx),
      slice: slice(),
    });
    for (let round = 1; round < slices + 1; round += 1) {
      const record = await getRunRecord(app, h.session.userId, h.ctx.runId);
      expect(record?.leaseOwner).toBeNull();
      expect(record?.lastEventType).toBe("policy.decided");
      await revive(h);
      expect(h.tasks).toHaveLength(1);
      const task = h.tasks.shift();
      if (round < slices) {
        const events = await readAllEvents(app, h.session.userId, h.ctx.runId);
        await executeRun({
          app,
          ctx: h.ctx,
          missionId: "automation-audit",
          input: { url: "https://acme.test/" },
          runner,
          registry: h.deps.registry,
          lease: createDbLease(app, h.ctx),
          resumeFrom: events,
          slice: slice(),
        });
      } else if (task !== undefined) await task();
    }
    const events = await readAllEvents(app, h.session.userId, h.ctx.runId);
    expect(foldRun(events).status).toBe("completed");
    expect(markers(events, RESUME_POLICY_ID)).toBe(0);
    expect(markers(events, HANDOFF_POLICY_ID)).toBe(slices);
  });

  it("hands a run off before starting it when the invocation has too little time left", async () => {
    const calls = { starts: 0, resumes: 0 };
    const runner = slowRunner(calls, 0);
    const h = await harness(runner);
    await executeRun({
      app,
      ctx: h.ctx,
      missionId: "automation-audit",
      input: { url: "https://acme.test/" },
      runner,
      registry: h.deps.registry,
      lease: createDbLease(app, h.ctx),
      slice: { startedAt: Date.now() - 280_000, budgetMs: 300_000, handoffAt: Date.now() + 5_000 },
    });
    expect(calls.starts).toBe(0);
    await revive(h);
    await drain(h);
    const events = await readAllEvents(app, h.session.userId, h.ctx.runId);
    expect(foldRun(events).status).toBe("completed");
    expect(calls.resumes).toBe(1);
    expect(markers(events, RESUME_POLICY_ID)).toBe(0);
  });
});
