import { createHash } from "node:crypto";

import { approvals, withTenant } from "@delegate/db";
import type { PlanStep, ShipApprovalRequest } from "@delegate/runtime";
import type { ToolApprovalRequest } from "@delegate/runtime/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  EXPIRED_NEEDS_THE_RUN,
  type InboxAction,
  inboxAction,
  SHIP_NEEDS_THE_DIFF,
} from "@/components/control/inbox-actions";

import { handlePlanDecision } from "../api";
import { type AppDatabase, createPgliteAppDatabase } from "../db";
import { createPlanApprovalWaiter, PLAN_TIMEOUT_MS } from "../plan-approval";
import { appendEvent, type RunContext } from "../runs";
import { handleShipDecision } from "../ship-api";
import { createShipApprovalWaiter, SHIP_APPROVAL_TIMEOUT_MS } from "../ship-approval";
import { createToolApprovalGate, TOOL_APPROVAL_TIMEOUT_MS } from "../tool-approval";
import { handleToolDecision } from "../tool-approval-api";
import { type InboxItem, listPendingApprovals } from "./inbox";
import { errorCode, jsonPost, newGuest, newRun, type TestGuest, testDeps } from "./testing";

let app: AppDatabase;

beforeAll(async () => {
  app = await createPgliteAppDatabase();
});

afterAll(async () => {
  await app.close();
});

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const steps: PlanStep[] = [
  {
    id: "map",
    role: "researcher",
    objective: "Map the site",
    inputs: [],
    capabilities: ["web.fetch"],
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

const shipRequest: ShipApprovalRequest = {
  approvalId: "ship_1",
  mode: "pull_request",
  repo: "acme/widget",
  base: "main",
  branch: "delegate/fix-flaky-test",
  title: "Fix the flaky retry test",
  diffStat: { files: 3, additions: 42, deletions: 7 },
  patchArtifactId: "patch-1",
  baseline: { command: "pnpm test", exitCode: 1, passed: false, durationMs: 4_200 },
  after: { command: "pnpm test", exitCode: 0, passed: true, durationMs: 4_100 },
  reason: "Opening a pull request on acme/widget needs your approval.",
};

const fullArgs = '{"body":"Escalate to ann@acme.example","id":"4711"}';

const toolRequest: ToolApprovalRequest = {
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

function send(action: InboxAction, cookie: string, headers: Record<string, string> = {}) {
  if (action.via !== "request") throw new Error(`expected a request, got ${action.via}`);
  const runId = /^\/api\/runs\/([^/]+)\//.exec(action.url)?.[1] ?? "";
  const request = jsonPost(action.url, cookie, action.body, headers);
  const deps = testDeps(app);
  if (action.url.endsWith("/plan")) return handlePlanDecision(request, runId, deps);
  if (action.url.endsWith("/ship")) return handleShipDecision(request, runId, deps);
  return handleToolDecision(request, runId, deps);
}

async function inbox(guest: TestGuest, now?: Date): Promise<InboxItem[]> {
  return (await listPendingApprovals(app, guest.session, now)).items;
}

async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the approval never appeared in the inbox");
}

function itemOf<K extends InboxItem["kind"]>(guest: TestGuest, ctx: RunContext, kind: K) {
  return until(async () =>
    (await inbox(guest)).find(
      (item): item is Extract<InboxItem, { kind: K }> =>
        item.kind === kind && item.runId === ctx.runId,
    ),
  );
}

function waitForPlan(ctx: RunContext, plan: PlanStep[] = steps, timeoutMs?: number) {
  return createPlanApprovalWaiter({
    app,
    ctx,
    autoApprove: false,
    pollMs: 5,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  })({ version: 1, steps: plan, kind: "initial" });
}

async function waitForShip(ctx: RunContext, timeoutMs?: number) {
  await appendEvent(app, ctx, { type: "ship.approval.requested", payload: shipRequest });
  return createShipApprovalWaiter({
    app,
    ctx,
    pollMs: 5,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  })(shipRequest);
}

function waitForTool(ctx: RunContext, request = toolRequest, timeoutMs?: number) {
  return createToolApprovalGate({
    app,
    ctx,
    pollMs: 5,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  }).decide(request);
}

describe("approvals inbox aggregation", () => {
  it("lists plan, ship and tool approvals across runs with the data each rule needs", async () => {
    const guest = await newGuest(app);
    const other = await newGuest(app);
    const planRun = await newRun(app, guest, { missionId: "automation-audit" });
    const shipRun = await newRun(app, guest, {
      missionId: "ship-a-pr",
      input: { repoUrl: "https://github.com/acme/widget" },
    });
    const toolRun = await newRun(app, guest, {
      missionId: "custom-goal",
      input: { goal: "Unblock payments" },
    });
    const foreign = await newRun(app, other);
    const pending = [
      waitForPlan(planRun, steps, 2_000),
      waitForShip(shipRun, 2_000),
      waitForTool(toolRun, toolRequest, 2_000),
      waitForPlan(foreign, steps, 2_000),
    ];
    const plan = await itemOf(guest, planRun, "plan");
    const ship = await itemOf(guest, shipRun, "ship");
    const tool = await itemOf(guest, toolRun, "tool");

    const items = await inbox(guest);
    expect(items.map((item) => item.kind).sort()).toEqual(["plan", "ship", "tool"]);
    expect(items.every((item) => !item.expired)).toBe(true);
    expect([...items].sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt))).toEqual(
      items,
    );

    expect(plan).toMatchObject({ mission: "automation-audit", target: "acme.example", steps });
    expect(Date.parse(plan.expiresAt) - Date.parse(plan.requestedAt)).toBe(PLAN_TIMEOUT_MS);

    expect(ship).toMatchObject({
      mission: "ship-a-pr",
      target: "acme/widget",
      mode: "pull_request",
      repo: "acme/widget",
      branch: "delegate/fix-flaky-test",
      base: "main",
      diffStat: { files: 3, additions: 42, deletions: 7 },
      title: "Fix the flaky retry test",
      baseline: { passed: false },
      after: { passed: true },
    });
    expect(Date.parse(ship.expiresAt) - Date.parse(ship.requestedAt)).toBe(
      SHIP_APPROVAL_TIMEOUT_MS,
    );

    expect(tool).toMatchObject({
      mission: "custom-goal",
      approvalId: "ap_1",
      tool: "mcp__tickets__add_comment",
      server: "tickets",
      action: "add_comment",
      capability: "connector.write",
      policyId: "builtin",
      argsJson: fullArgs,
      argsSha256: sha256(fullArgs),
    });
    expect(Date.parse(tool.expiresAt) - Date.parse(tool.requestedAt)).toBe(
      TOOL_APPROVAL_TIMEOUT_MS,
    );

    const theirs = await inbox(other);
    expect(theirs).toHaveLength(1);
    expect(theirs[0]?.runId).toBe(foreign.runId);
    await Promise.all(pending);
  });

  it("is empty for a workspace with nothing waiting", async () => {
    const guest = await newGuest(app);
    await newRun(app, guest);
    expect(await listPendingApprovals(app, guest.session)).toEqual({ items: [], truncated: false });
  });

  it("hides approvals of finished runs, older duplicates and rows it cannot read", async () => {
    const guest = await newGuest(app);
    const finished = await newRun(app, guest);
    const outstanding = waitForPlan(finished, steps, 1_000);
    await itemOf(guest, finished, "plan");
    await appendEvent(app, finished, {
      type: "run.failed",
      payload: { error: { code: "cancelled", message: "cancelled by user" } },
    });
    expect(await inbox(guest)).toEqual([]);
    await outstanding;

    const resumed = await newRun(app, guest);
    const first = waitForPlan(resumed, steps, 1_000);
    await itemOf(guest, resumed, "plan");
    const smaller = steps.slice(0, 1);
    const second = waitForPlan(resumed, smaller, 1_000);
    const newest = await until(async () =>
      (await inbox(guest)).find((item) => item.kind === "plan" && item.steps.length === 1),
    );
    expect((await inbox(guest)).filter((item) => item.runId === resumed.runId)).toEqual([newest]);

    const broken = await newRun(app, guest);
    await withTenant(app.db, guest.session.userId, (tx) =>
      tx.insert(approvals).values([
        {
          runId: broken.runId,
          workspaceId: broken.workspaceId,
          stepId: "tool",
          action: {
            kind: "tool",
            approvalId: "ap_9",
            tool: "mcp__tickets__close",
            argsSummary: "",
            argsJson: '{"id":"1"}',
            argsSha256: sha256('{"id":"2"}'),
          },
        },
        {
          runId: broken.runId,
          workspaceId: broken.workspaceId,
          stepId: "something-else",
          action: { kind: "plan", steps },
        },
      ]),
    );
    expect((await inbox(guest)).filter((item) => item.runId === broken.runId)).toEqual([]);
    await Promise.all([first, second]);
  });

  it("marks a request past its deadline and offers only the run page for it", async () => {
    const guest = await newGuest(app);
    const ctx = await newRun(app, guest);
    const outstanding = waitForTool(ctx, toolRequest, 1_000);
    const live = await itemOf(guest, ctx, "tool");
    expect(live.expired).toBe(false);
    const later = new Date(Date.parse(live.expiresAt) + 1);
    const [late] = await inbox(guest, later);
    expect(late?.expired).toBe(true);
    if (late === undefined) throw new Error("item missing");
    for (const decision of ["approved", "rejected"] as const)
      expect(inboxAction(late, decision)).toEqual({
        via: "run_page",
        href: `/runs/${ctx.runId}`,
        why: EXPIRED_NEEDS_THE_RUN,
      });
    await outstanding;
  });
});

describe("deciding from the inbox uses the run page's endpoints and guards", () => {
  it("approves a plan with exactly the steps that were shown", async () => {
    const guest = await newGuest(app);
    const ctx = await newRun(app, guest);
    const decision = waitForPlan(ctx);
    const item = await itemOf(guest, ctx, "plan");
    const action = inboxAction(item, "approved");
    expect(action).toEqual({
      via: "request",
      url: `/api/runs/${ctx.runId}/plan`,
      body: { decision: "approved", steps },
    });
    const response = await send(action, guest.cookie);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ decision: "approved", edited: false });
    await expect(decision).resolves.toEqual({ decision: "approved" });
    expect(await inbox(guest)).toEqual([]);
  });

  it("rejects a plan with a reason", async () => {
    const guest = await newGuest(app);
    const ctx = await newRun(app, guest);
    const decision = waitForPlan(ctx);
    const item = await itemOf(guest, ctx, "plan");
    const response = await send(inboxAction(item, "rejected", "  Too broad  "), guest.cookie);
    expect(response.status).toBe(200);
    await expect(decision).resolves.toEqual({ decision: "rejected", reason: "Too broad" });
  });

  it("never approves a plan the reviewer did not see", async () => {
    const guest = await newGuest(app);
    const ctx = await newRun(app, guest);
    const first = waitForPlan(ctx, steps, 1_500);
    const reviewed = await itemOf(guest, ctx, "plan");

    const replaced: PlanStep[] = [{ ...steps[0], id: "crawl" } as PlanStep];
    const second = waitForPlan(ctx, replaced, 1_500);
    await until(async () =>
      (await inbox(guest)).find((item) => item.kind === "plan" && item.steps[0]?.id === "crawl"),
    );
    const refused = await send(inboxAction(reviewed, "approved"), guest.cookie);
    expect(refused.status).toBe(400);
    expect(await errorCode(refused)).toBe("invalid_plan");

    const wider: PlanStep[] = [
      ...steps,
      { ...steps[1], id: "write", inputs: ["rank"], budgetShare: 0.1 } as PlanStep,
    ];
    const third = waitForPlan(ctx, wider, 1_500);
    await until(async () =>
      (await inbox(guest)).find((item) => item.kind === "plan" && item.steps.length === 3),
    );
    const narrowed = await send(inboxAction(reviewed, "approved"), guest.cookie);
    expect(narrowed.status).toBe(200);
    expect(await narrowed.json()).toEqual({ decision: "approved", edited: true });
    await expect(third).resolves.toEqual({ decision: "approved", steps });
    await Promise.all([first, second]);
  });

  it("approves a connector call by sending the hash of the arguments that were shown", async () => {
    const guest = await newGuest(app);
    const ctx = await newRun(app, guest);
    const decision = waitForTool(ctx);
    const item = await itemOf(guest, ctx, "tool");
    const action = inboxAction(item, "approved");
    expect(action).toEqual({
      via: "request",
      url: `/api/runs/${ctx.runId}/tool-approval`,
      body: { approvalId: "ap_1", decision: "approved", argsSha256: sha256(fullArgs) },
    });
    const response = await send(action, guest.cookie);
    expect(response.status).toBe(200);
    await expect(decision).resolves.toMatchObject({
      resolution: "approved",
      resolvedBy: { type: "guest", id: guest.session.userId },
    });
  });

  it("rejects a connector call", async () => {
    const guest = await newGuest(app);
    const ctx = await newRun(app, guest);
    const decision = waitForTool(ctx);
    const item = await itemOf(guest, ctx, "tool");
    const response = await send(inboxAction(item, "rejected", "Not now"), guest.cookie);
    expect(response.status).toBe(200);
    await expect(decision).resolves.toMatchObject({ resolution: "rejected", note: "Not now" });
  });

  it("answers 409 when the arguments changed after they were shown", async () => {
    const guest = await newGuest(app);
    const ctx = await newRun(app, guest);
    const first = waitForTool(ctx, toolRequest, 1_500);
    const reviewed = await itemOf(guest, ctx, "tool");
    const swapped = '{"body":"Delete every ticket","id":"4711"}';
    const second = waitForTool(
      ctx,
      { ...toolRequest, argsJson: swapped, argsSha256: sha256(swapped) },
      1_500,
    );
    await until(async () =>
      (await inbox(guest)).find((item) => item.kind === "tool" && item.argsJson === swapped),
    );
    const stale = await send(inboxAction(reviewed, "approved"), guest.cookie);
    expect(stale.status).toBe(409);
    expect(await errorCode(stale)).toBe("arguments_changed");
    await expect(second).resolves.toMatchObject({ resolution: "rejected" });
    await first;
  });

  it("links to the run page instead of approving a ship request, and can reject it", async () => {
    const guest = await newGuest(app);
    const ctx = await newRun(app, guest, { missionId: "ship-a-pr" });
    const decision = waitForShip(ctx);
    const item = await itemOf(guest, ctx, "ship");
    expect(inboxAction(item, "approved")).toEqual({
      via: "run_page",
      href: `/runs/${ctx.runId}`,
      why: SHIP_NEEDS_THE_DIFF,
    });
    const action = inboxAction(item, "rejected", "Wrong branch");
    expect(action).toEqual({
      via: "request",
      url: `/api/runs/${ctx.runId}/ship`,
      body: { decision: "rejected", reason: "Wrong branch" },
    });
    const response = await send(action, guest.cookie);
    expect(response.status).toBe(200);
    await expect(decision).resolves.toMatchObject({
      decision: "rejected",
      reason: "Wrong branch",
      rejectedBy: { type: "guest", id: guest.session.userId },
    });
  });

  it("the run page's ship approval still works after the inbox sent the reviewer there", async () => {
    const guest = await newGuest(app);
    const ctx = await newRun(app, guest, { missionId: "ship-a-pr" });
    const decision = waitForShip(ctx);
    await itemOf(guest, ctx, "ship");
    const response = await handleShipDecision(
      jsonPost(`/api/runs/${ctx.runId}/ship`, guest.cookie, { decision: "approved" }),
      ctx.runId,
      testDeps(app),
    );
    expect(response.status).toBe(200);
    await expect(decision).resolves.toMatchObject({ decision: "approved" });
    expect(await inbox(guest)).toEqual([]);
  });

  it("refuses another visitor with 404 and another origin with 403 for every kind", async () => {
    const guest = await newGuest(app);
    const stranger = await newGuest(app);
    const planRun = await newRun(app, guest);
    const shipRun = await newRun(app, guest, { missionId: "ship-a-pr" });
    const toolRun = await newRun(app, guest, { missionId: "custom-goal" });
    const outstanding = [
      waitForPlan(planRun, steps, 1_500),
      waitForShip(shipRun, 1_500),
      waitForTool(toolRun, toolRequest, 1_500),
    ];
    const actions = [
      inboxAction(await itemOf(guest, planRun, "plan"), "approved"),
      inboxAction(await itemOf(guest, planRun, "plan"), "rejected"),
      inboxAction(await itemOf(guest, shipRun, "ship"), "rejected"),
      inboxAction(await itemOf(guest, toolRun, "tool"), "approved"),
      inboxAction(await itemOf(guest, toolRun, "tool"), "rejected"),
    ];
    expect(await inbox(stranger)).toEqual([]);
    for (const action of actions) {
      const foreign = await send(action, stranger.cookie);
      expect(foreign.status).toBe(404);
      const crossSite = await send(action, guest.cookie, { origin: "https://evil.example" });
      expect(crossSite.status).toBe(403);
      expect(await errorCode(crossSite)).toBe("forbidden_origin");
    }
    expect(await inbox(guest)).toHaveLength(3);
    await Promise.all(outstanding);
  });
});
