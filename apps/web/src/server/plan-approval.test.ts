import type { PlanStep } from "@delegate/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type ApiDeps, handlePlanDecision } from "./api";
import { type AppDatabase, createPgliteAppDatabase } from "./db";
import { createFakeRunner } from "./fake-runner";
import { createPlanApprovalWaiter, pendingPlanApproval, readPlanDecision } from "./plan-approval";
import { createRunRegistry } from "./run-registry";
import { appendEvent, createRunRecord, type RunContext } from "./runs";
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
    budgetShare: 0.4,
  },
  {
    id: "rank",
    role: "analyst",
    objective: "Rank opportunities",
    inputs: ["map"],
    capabilities: [],
    acceptance: ["ok"],
    budgetShare: 0.4,
  },
];

function deps(): ApiDeps {
  return {
    app: () => Promise.resolve(app),
    secret: () => secret,
    guestLimiter: createRateLimiter({ limit: 5, windowMs: 3_600_000 }),
    ipLimiter: createRateLimiter({ limit: 50, windowMs: 3_600_000 }),
    registry: createRunRegistry(),
    runner: () => ({ execution: "simulated", run: createFakeRunner({ delayMs: 0 }) }),
    schedule: () => undefined,
    production: false,
  };
}

async function newRun(): Promise<{ ctx: RunContext; cookie: string; session: GuestSession }> {
  const { session } = await resolveGuest(app, undefined, secret);
  const { runId } = await createRunRecord(app, session, {
    missionId: "automation-audit",
    input: { url: "https://acme.test/" },
    execution: "simulated",
  });
  const ctx = { runId, workspaceId: session.workspaceId, userId: session.userId };
  await appendEvent(app, ctx, { type: "plan.proposed", payload: { version: 1, steps } });
  return { ctx, session, cookie: `delegate_session=${signSession(session, secret)}` };
}

function post(runId: string, cookie: string, body: unknown, origin = ORIGIN) {
  return new Request(`${ORIGIN}/api/runs/${runId}/plan`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, host: "localhost:3000", cookie },
    body: JSON.stringify(body),
  });
}

async function waitForPending(ctx: RunContext) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await pendingPlanApproval(app, ctx.userId, ctx.runId)) !== null) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("plan approval never opened");
}

describe("plan approval", () => {
  it("waits for an approval with edited steps written through the API", async () => {
    const { ctx, cookie } = await newRun();
    const wait = createPlanApprovalWaiter({ app, ctx, autoApprove: false, pollMs: 5 });
    const decision = wait({ version: 1, steps }, new AbortController().signal);
    await waitForPending(ctx);

    const edited = [{ ...steps[0], objective: "Map pricing and careers pages" }];
    const response = await handlePlanDecision(
      post(ctx.runId, cookie, { decision: "approved", steps: edited }),
      ctx.runId,
      deps(),
    );
    expect(response.status).toBe(200);
    await expect(decision).resolves.toEqual({ decision: "approved", steps: edited });

    const again = await handlePlanDecision(
      post(ctx.runId, cookie, { decision: "rejected" }),
      ctx.runId,
      deps(),
    );
    expect(again.status).toBe(409);
  });

  it("rejects invalid edits, cross-origin posts and other sessions", async () => {
    const { ctx, cookie } = await newRun();
    const wait = createPlanApprovalWaiter({ app, ctx, autoApprove: false, pollMs: 5 });
    const controller = new AbortController();
    const decision = wait({ version: 1, steps }, controller.signal);
    await waitForPending(ctx);

    const reordered = [steps[1], steps[0]];
    const invalid = await handlePlanDecision(
      post(ctx.runId, cookie, { decision: "approved", steps: reordered }),
      ctx.runId,
      deps(),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: "invalid_plan" } });

    const escalated = await handlePlanDecision(
      post(ctx.runId, cookie, {
        decision: "approved",
        steps: [{ ...steps[0], capabilities: ["fetch", "send_email"] }],
      }),
      ctx.runId,
      deps(),
    );
    expect(escalated.status).toBe(400);

    const cross = await handlePlanDecision(
      post(ctx.runId, cookie, { decision: "approved" }, "https://evil.example"),
      ctx.runId,
      deps(),
    );
    expect(cross.status).toBe(403);

    const other = await newRun();
    const foreign = await handlePlanDecision(
      post(ctx.runId, other.cookie, { decision: "approved" }),
      ctx.runId,
      deps(),
    );
    expect(foreign.status).toBe(404);

    controller.abort(new Error("cancelled"));
    await expect(decision).rejects.toThrow("cancelled");
  });

  it("rejects with a reason and records it", async () => {
    const { ctx, cookie } = await newRun();
    const wait = createPlanApprovalWaiter({ app, ctx, autoApprove: false, pollMs: 5 });
    const decision = wait({ version: 1, steps }, new AbortController().signal);
    await waitForPending(ctx);
    const response = await handlePlanDecision(
      post(ctx.runId, cookie, { decision: "rejected", reason: "Wrong department" }),
      ctx.runId,
      deps(),
    );
    expect(response.status).toBe(200);
    await expect(decision).resolves.toEqual({ decision: "rejected", reason: "Wrong department" });
  });

  it("times out into a rejection and auto-approves when the guest opted in", async () => {
    const first = await newRun();
    const timeout = createPlanApprovalWaiter({
      app,
      ctx: first.ctx,
      autoApprove: false,
      pollMs: 5,
      timeoutMs: 30,
    });
    await expect(timeout({ version: 1, steps }, new AbortController().signal)).resolves.toEqual({
      decision: "rejected",
      reason: "Plan approval timed out.",
    });

    const second = await newRun();
    const auto = createPlanApprovalWaiter({ app, ctx: second.ctx, autoApprove: true, pollMs: 5 });
    const result = await auto({ version: 1, steps }, new AbortController().signal);
    expect(result).toEqual({ decision: "approved", auto: true });
    const recorded = await readPlanDecision(app, second.ctx.userId, second.ctx.runId);
    expect(recorded).toMatchObject({ decision: "approved", auto: true });
  });
});
