import { createHash } from "node:crypto";

import { githubInstallations, withTenant } from "@delegate/db";
import type { RunEvent } from "@delegate/runtime";
import type { ToolApprovalRequest } from "@delegate/runtime/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pendingToolCalls } from "@/lib/runs/tool-approvals";

import type { ApiDeps } from "./api";
import { type AppDatabase, createPgliteAppDatabase } from "./db";
import { reviveOrSweep } from "./durable";
import { connectedInstallations } from "./github-connect";
import type { MissionRunArgs, MissionRunner } from "./mission-runner";
import { createRunRegistry } from "./run-registry";
import { createRunRecord, getRunRecord, type RunContext } from "./runs";
import { createRateLimiter, resolveGuest, signSession } from "./session";
import { createToolApprovalGate, pendingToolApprovals } from "./tool-approval";
import { handleListToolApprovals, handleToolDecision } from "./tool-approval-api";

const ORIGIN = "http://localhost:3000";
const secret = "s".repeat(32);
let app: AppDatabase;

beforeAll(async () => {
  app = await createPgliteAppDatabase();
});

afterAll(async () => {
  await app.close();
});

function deps(overrides: Partial<ApiDeps> = {}): ApiDeps {
  return {
    app: () => Promise.resolve(app),
    secret: () => secret,
    guestLimiter: createRateLimiter({ limit: 50, windowMs: 3_600_000 }),
    ipLimiter: createRateLimiter({ limit: 50, windowMs: 3_600_000 }),
    registry: createRunRegistry(),
    runner: () => {
      throw new Error("not used");
    },
    schedule: () => undefined,
    production: false,
    ...overrides,
  };
}

async function newRun(mission = "custom-goal"): Promise<{ ctx: RunContext; cookie: string }> {
  const { session } = await resolveGuest(app, undefined, secret);
  const { runId } = await createRunRecord(app, session, {
    missionId: mission,
    input: { goal: "Unblock payments", url: "https://acme.example/" },
    execution: "live",
  });
  return {
    ctx: { runId, workspaceId: session.workspaceId, userId: session.userId },
    cookie: `delegate_session=${signSession(session, secret)}`,
  };
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const fullArgs = '{"body":"Escalate to ann@acme.example","id":"4711"}';

const request: ToolApprovalRequest = {
  approvalId: "ap_1",
  toolCallId: "tc_2",
  stepId: "use_connectors",
  tool: "mcp__tickets__add_comment",
  capability: "connector.write",
  argsSummary: 'tickets.add_comment {"id":"4711","body":"[redacted:email]"}',
  argsJson: fullArgs,
  argsSha256: sha256(fullArgs),
  policyId: "builtin",
  reason: "Capability connector.write has side effects and always requires human approval",
};

function list(runId: string, cookie: string) {
  return new Request(`${ORIGIN}/api/runs/${runId}/tool-approval`, {
    headers: { origin: ORIGIN, host: "localhost:3000", cookie },
  });
}

function decide(runId: string, cookie: string, body: unknown) {
  return new Request(`${ORIGIN}/api/runs/${runId}/tool-approval`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, host: "localhost:3000", cookie },
    body: JSON.stringify(body),
  });
}

async function waitForPending(ctx: RunContext) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await pendingToolApprovals(app, ctx.userId, ctx.runId)).length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("tool approval never opened");
}

describe("durable approval of connector write calls", () => {
  it("pauses until a person approves on the run page", async () => {
    const { ctx, cookie } = await newRun();
    const gate = createToolApprovalGate({ app, ctx, pollMs: 5 });
    const decision = gate.decide(request);
    await waitForPending(ctx);
    const [pending] = await pendingToolApprovals(app, ctx.userId, ctx.runId);
    expect(pending).toMatchObject({
      tool: request.tool,
      argsJson: fullArgs,
      argsSha256: request.argsSha256,
    });
    const listed = await handleListToolApprovals(list(ctx.runId, cookie), ctx.runId, deps());
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      approvals: [
        {
          approvalId: "ap_1",
          tool: request.tool,
          argsJson: fullArgs,
          argsSha256: request.argsSha256,
        },
      ],
    });
    const response = await handleToolDecision(
      decide(ctx.runId, cookie, {
        approvalId: "ap_1",
        decision: "approved",
        argsSha256: request.argsSha256,
      }),
      ctx.runId,
      deps(),
    );
    expect(response.status).toBe(200);
    await expect(decision).resolves.toMatchObject({
      resolution: "approved",
      resolvedBy: { type: "guest", id: ctx.userId },
    });
  });

  it("refuses an approval for arguments other than the ones waiting", async () => {
    const { ctx, cookie } = await newRun();
    const decision = createToolApprovalGate({ app, ctx, pollMs: 5, timeoutMs: 300 }).decide(
      request,
    );
    await waitForPending(ctx);
    const stale = await handleToolDecision(
      decide(ctx.runId, cookie, {
        approvalId: "ap_1",
        decision: "approved",
        argsSha256: sha256('{"id":"4711"}'),
      }),
      ctx.runId,
      deps(),
    );
    expect(stale.status).toBe(409);
    expect(await pendingToolApprovals(app, ctx.userId, ctx.runId)).toHaveLength(1);
    await expect(decision).resolves.toMatchObject({ resolution: "rejected" });
  });

  it("reuses an approval row only while it is pending and for the same arguments", async () => {
    const { ctx, cookie } = await newRun();
    const first = createToolApprovalGate({ app, ctx, pollMs: 5 }).decide(request);
    await waitForPending(ctx);
    await handleToolDecision(
      decide(ctx.runId, cookie, {
        approvalId: "ap_1",
        decision: "approved",
        argsSha256: request.argsSha256,
      }),
      ctx.runId,
      deps(),
    );
    await expect(first).resolves.toMatchObject({ resolution: "approved" });
    const swapped = '{"body":"Delete every ticket","id":"4711"}';
    const second = createToolApprovalGate({ app, ctx, pollMs: 5, timeoutMs: 300 }).decide({
      ...request,
      argsJson: swapped,
      argsSha256: sha256(swapped),
    });
    await waitForPending(ctx);
    const [pending] = await pendingToolApprovals(app, ctx.userId, ctx.runId);
    expect(pending?.argsJson).toBe(swapped);
    await expect(second).resolves.toMatchObject({ resolution: "rejected" });
    const third = createToolApprovalGate({ app, ctx, pollMs: 5, timeoutMs: 300 }).decide(request);
    await waitForPending(ctx);
    await expect(third).resolves.toMatchObject({ resolution: "rejected" });
  });

  it("returns the rejection and its reason", async () => {
    const { ctx, cookie } = await newRun();
    const decision = createToolApprovalGate({ app, ctx, pollMs: 5 }).decide(request);
    await waitForPending(ctx);
    await handleToolDecision(
      decide(ctx.runId, cookie, { approvalId: "ap_1", decision: "rejected", reason: "Not now" }),
      ctx.runId,
      deps(),
    );
    await expect(decision).resolves.toMatchObject({ resolution: "rejected", note: "Not now" });
  });

  it("rejects automatically when nobody answers in time", async () => {
    const { ctx } = await newRun();
    let clock = Date.now();
    const decision = await createToolApprovalGate({
      app,
      ctx,
      pollMs: 1,
      timeoutMs: 50,
      now: () => (clock += 30),
    }).decide(request);
    expect(decision).toMatchObject({
      resolution: "rejected",
      resolvedBy: { type: "system", id: "tool-approval-timeout" },
    });
    expect(await pendingToolApprovals(app, ctx.userId, ctx.runId)).toEqual([]);
  });

  it("refuses decisions from another visitor, another origin or for an unknown call", async () => {
    const { ctx, cookie } = await newRun();
    const stranger = await newRun();
    const outstanding = createToolApprovalGate({ app, ctx, pollMs: 5, timeoutMs: 200 }).decide(
      request,
    );
    await waitForPending(ctx);
    const body = { approvalId: "ap_1", decision: "approved", argsSha256: request.argsSha256 };
    expect(
      (await handleToolDecision(decide(ctx.runId, stranger.cookie, body), ctx.runId, deps()))
        .status,
    ).toBe(404);
    expect(
      (await handleListToolApprovals(list(ctx.runId, stranger.cookie), ctx.runId, deps())).status,
    ).toBe(404);
    const crossSite = new Request(`${ORIGIN}/api/runs/${ctx.runId}/tool-approval`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
        host: "localhost:3000",
        cookie,
      },
      body: JSON.stringify(body),
    });
    expect((await handleToolDecision(crossSite, ctx.runId, deps())).status).toBe(403);
    const unknown = await handleToolDecision(
      decide(ctx.runId, cookie, {
        approvalId: "ap_9",
        decision: "approved",
        argsSha256: request.argsSha256,
      }),
      ctx.runId,
      deps(),
    );
    expect(unknown.status).toBe(409);
    await expect(outstanding).resolves.toMatchObject({ resolution: "rejected" });
  });
});

describe("pending tool calls on the run page", () => {
  const at = "2026-11-25T10:00:00.000Z";
  const requested = (seq: number, approvalId: string): RunEvent => ({
    runId: "r",
    seq,
    at,
    type: "approval.requested",
    stepId: "use_connectors",
    payload: {
      approvalId,
      toolCallId: "tc_2",
      policyId: "builtin",
      reason: "needs approval",
      summary: `mcp__tickets__add_comment: tickets.add_comment {"id":"4711"}`,
    },
  });
  const resolved = (seq: number, approvalId: string): RunEvent => ({
    runId: "r",
    seq,
    at,
    type: "approval.resolved",
    payload: { approvalId, resolution: "approved", resolvedBy: { type: "guest", id: "g" } },
  });

  it("shows the server, action and redacted arguments of unanswered calls", () => {
    expect(pendingToolCalls([requested(1, "ap_1")])).toEqual([
      expect.objectContaining({
        server: "tickets",
        action: "add_comment",
        args: '{"id":"4711"}',
        approvalId: "ap_1",
      }),
    ]);
    expect(pendingToolCalls([requested(1, "ap_1"), resolved(2, "ap_1")])).toEqual([]);
    expect(
      pendingToolCalls([requested(1, "ap_1"), resolved(2, "ap_1"), requested(3, "ap_1")]),
    ).toHaveLength(1);
  });
});

describe("Ship-a-PR uses the visitor's connected installation", () => {
  it("finds the installation for a connected repository and nothing for others", async () => {
    const { ctx } = await newRun("ship-a-pr");
    await withTenant(app.db, ctx.userId, (tx) =>
      tx.insert(githubInstallations).values({
        workspaceId: ctx.workspaceId,
        installationId: 77,
        accountLogin: "acme",
        accountType: "Organization",
        repositorySelection: "selected",
        repositories: ["acme/widgets"],
        githubUserId: 4242,
        githubLogin: "acme-dev",
      }),
    );
    const find = connectedInstallations(() => Promise.resolve(app))(ctx.workspaceId, ctx.userId);
    await expect(find("acme", "widgets")).resolves.toEqual({
      installationId: 77,
      collaborator: "acme-dev",
    });
    await expect(find("acme", "gadgets")).resolves.toBeNull();
    const other = await newRun("ship-a-pr");
    await expect(
      connectedInstallations(() => Promise.resolve(app))(other.ctx.workspaceId, other.ctx.userId)(
        "acme",
        "widgets",
      ),
    ).resolves.toBeNull();
  });
});

describe("durable resume", () => {
  it("reloads the workspace's connectors when a stale run is resumed", async () => {
    const { ctx } = await newRun("company-xray");
    const record = await getRunRecord(app, ctx.userId, ctx.runId);
    if (record === null) throw new Error("run not found");
    const seen: MissionRunArgs[] = [];
    const tasks: Promise<void>[] = [];
    const runner: MissionRunner = async (args) => {
      seen.push(args);
      await args.emit({ type: "run.completed", payload: { summary: "done" } });
      return { status: "completed" };
    };
    const loaded: string[] = [];
    await reviveOrSweep(app, ctx.userId, record, {
      ...deps(),
      runner: () => ({ execution: "live", run: runner }),
      schedule: (task) => {
        tasks.push(task());
      },
      connections: (_app, runCtx) => {
        loaded.push(runCtx.runId);
        return Promise.resolve({ tools: [], hosts: ["mcp.tickets.example"] });
      },
      now: () => new Date(Date.now() + 60_000),
    });
    await Promise.all(tasks);
    expect(loaded).toEqual([ctx.runId]);
    expect(seen[0]?.connections?.hosts).toEqual(["mcp.tickets.example"]);
  });
});
