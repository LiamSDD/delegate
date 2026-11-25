import type { ShipApprovalRequest } from "@delegate/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ApiDeps } from "./api";
import { type AppDatabase, createPgliteAppDatabase } from "./db";
import { createFakeRunner } from "./fake-runner";
import type { MissionRunArgs, MissionRunner } from "./mission-runner";
import { createRunRegistry } from "./run-registry";
import { type RunContext, createRunRecord } from "./runs";
import { createRateLimiter, resolveGuest, signSession } from "./session";
import { handleCreateShipRun, handleShipDecision } from "./ship-api";
import { createShipApprovalWaiter, pendingShipApproval } from "./ship-approval";

const ORIGIN = "http://localhost:3000";
const secret = "s".repeat(32);

let app: AppDatabase;

beforeAll(async () => {
  app = await createPgliteAppDatabase();
});

afterAll(async () => {
  await app.close();
});

const improvement = {
  id: "imp-1",
  title: "Make sum handle empty lists",
  rationale: "sum([]) throws.",
  files: ["src/sum.js"],
  kind: "bugfix",
  effort: "S",
  acceptance: ["sum([]) returns 0"],
};

const request: ShipApprovalRequest = {
  approvalId: "ship_abc",
  mode: "pull_request",
  repo: "acme/widgets",
  base: "main",
  branch: "delegate/imp-1-abcdef0",
  title: "Make sum handle empty lists",
  diffStat: { files: 1, additions: 1, deletions: 1 },
  patchArtifactId: "art_1",
  baseline: { command: "npm test", exitCode: 1, passed: false, durationMs: 10 },
  after: { command: "npm test", exitCode: 0, passed: true, durationMs: 10 },
  reason: "Opening a pull request on acme/widgets needs your approval.",
};

function deps(
  runner: MissionRunner | null,
  overrides: Partial<ApiDeps> = {},
): ApiDeps & { tasks: (() => Promise<void>)[] } {
  const tasks: (() => Promise<void>)[] = [];
  return {
    app: () => Promise.resolve(app),
    secret: () => secret,
    guestLimiter: createRateLimiter({ limit: 5, windowMs: 3_600_000 }),
    ipLimiter: createRateLimiter({ limit: 50, windowMs: 3_600_000 }),
    registry: createRunRegistry(),
    runner: () =>
      runner === null
        ? { execution: "simulated", run: createFakeRunner({ delayMs: 0 }) }
        : { execution: "live", run: runner },
    schedule: (task) => {
      tasks.push(task);
    },
    production: false,
    shipEnabled: true,
    tasks,
    ...overrides,
  };
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      host: "localhost:3000",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/ship", () => {
  it("is unavailable until the Ship-a-PR flag is on", async () => {
    const response = await handleCreateShipRun(
      post("/api/ship", { repoUrl: "https://github.com/acme/widgets", improvement }),
      deps(null, { shipEnabled: false }),
    );
    expect(response.status).toBe(503);
  });

  it("refuses the simulated runner instead of pretending to run code", async () => {
    const response = await handleCreateShipRun(
      post("/api/ship", { repoUrl: "https://github.com/acme/widgets", improvement }),
      deps(null),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "unavailable" } });
  });

  it.each([
    { repoUrl: "https://gitlab.com/acme/widgets", improvement },
    { repoUrl: "https://github.com/acme/widgets", ref: "--upload-pack=x", improvement },
    {
      repoUrl: "https://github.com/acme/widgets",
      improvement: { ...improvement, kind: "rewrite" },
    },
    { repoUrl: "https://github.com/acme/widgets", improvement, extra: true },
  ])("rejects an invalid request %#", async (body) => {
    const response = await handleCreateShipRun(
      post("/api/ship", body),
      deps(() => Promise.resolve({ status: "completed" as const })),
    );
    expect(response.status).toBe(400);
  });

  it("rejects cross-origin starts", async () => {
    const response = await handleCreateShipRun(
      post(
        "/api/ship",
        { repoUrl: "https://github.com/acme/widgets", improvement },
        { origin: "https://evil.example" },
      ),
      deps(() => Promise.resolve({ status: "completed" as const })),
    );
    expect(response.status).toBe(403);
  });

  it("creates a ship-a-pr run and hands the runner a ship approval waiter", async () => {
    const seen: MissionRunArgs[] = [];
    const runner: MissionRunner = async (args) => {
      seen.push(args);
      await args.emit({ type: "run.completed", payload: { summary: "done" } });
      return { status: "completed" };
    };
    const api = deps(runner);
    const response = await handleCreateShipRun(
      post("/api/ship", { repoUrl: "https://github.com/acme/widgets", ref: "main", improvement }),
      api,
    );
    expect(response.status).toBe(201);
    await api.tasks[0]?.();
    expect(seen[0]?.missionId).toBe("ship-a-pr");
    expect(seen[0]?.input).toMatchObject({
      repoUrl: "https://github.com/acme/widgets",
      ref: "main",
      improvement: { id: "imp-1" },
    });
    expect(seen[0]?.awaitShipApproval).toBeTypeOf("function");
    expect(seen[0]?.findInstallation).toBeUndefined();
  });

  it("scopes the installation lookup to the visitor's own workspace", async () => {
    const seen: MissionRunArgs[] = [];
    const workspaces: string[] = [];
    const runner: MissionRunner = async (args) => {
      seen.push(args);
      await args.emit({ type: "run.completed", payload: { summary: "done" } });
      return { status: "completed" };
    };
    const api = deps(runner, {
      shipInstallations: (workspaceId) => {
        workspaces.push(workspaceId);
        return () => Promise.resolve({ installationId: 9 });
      },
    });
    const response = await handleCreateShipRun(
      post("/api/ship", { repoUrl: "https://github.com/acme/widgets", improvement }),
      api,
    );
    expect(response.status).toBe(201);
    await api.tasks[0]?.();
    expect(workspaces).toHaveLength(1);
    await expect(seen[0]?.findInstallation?.("acme", "widgets")).resolves.toEqual({
      installationId: 9,
    });
  });
});

async function newShipRun(): Promise<{ ctx: RunContext; cookie: string }> {
  const { session } = await resolveGuest(app, undefined, secret);
  const { runId } = await createRunRecord(app, session, {
    missionId: "ship-a-pr",
    input: { repoUrl: "https://github.com/acme/widgets", improvement },
    execution: "live",
  });
  return {
    ctx: { runId, workspaceId: session.workspaceId, userId: session.userId },
    cookie: `delegate_session=${signSession(session, secret)}`,
  };
}

async function waitForPending(ctx: RunContext) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await pendingShipApproval(app, ctx.userId, ctx.runId)) !== null) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("ship approval never opened");
}

describe("ship approval", () => {
  it("returns the reviewer's approval to the waiting mission, once", async () => {
    const { ctx, cookie } = await newShipRun();
    const wait = createShipApprovalWaiter({ app, ctx, pollMs: 5 });
    const decision = wait(request, new AbortController().signal);
    await waitForPending(ctx);
    const api = deps(null);
    const path = `/api/runs/${ctx.runId}/ship`;

    const cross = await handleShipDecision(
      post(path, { decision: "approved" }, { cookie, origin: "https://evil.example" }),
      ctx.runId,
      api,
    );
    expect(cross.status).toBe(403);
    const stranger = await handleShipDecision(post(path, { decision: "approved" }), ctx.runId, api);
    expect(stranger.status).toBe(404);

    const approved = await handleShipDecision(
      post(path, { decision: "approved" }, { cookie }),
      ctx.runId,
      api,
    );
    expect(approved.status).toBe(200);
    await expect(decision).resolves.toMatchObject({
      decision: "approved",
      approvedBy: { type: "guest", id: ctx.userId },
    });
    const again = await handleShipDecision(
      post(path, { decision: "rejected" }, { cookie }),
      ctx.runId,
      api,
    );
    expect(again.status).toBe(409);
  });

  it("reuses the recorded decision when a resumed run asks again", async () => {
    const { ctx, cookie } = await newShipRun();
    const first = createShipApprovalWaiter({ app, ctx, pollMs: 5 })(request);
    await waitForPending(ctx);
    await handleShipDecision(
      post(
        `/api/runs/${ctx.runId}/ship`,
        { decision: "rejected", reason: "Not this one" },
        { cookie },
      ),
      ctx.runId,
      deps(null),
    );
    await expect(first).resolves.toMatchObject({ decision: "rejected", reason: "Not this one" });
    await expect(createShipApprovalWaiter({ app, ctx, pollMs: 5 })(request)).resolves.toMatchObject(
      {
        decision: "rejected",
        reason: "Not this one",
      },
    );
  });

  it("times out as a rejection", async () => {
    const { ctx } = await newShipRun();
    let clock = Date.now();
    const wait = createShipApprovalWaiter({
      app,
      ctx,
      pollMs: 5,
      timeoutMs: 1_000,
      now: () => clock,
    });
    const decision = wait(request);
    await waitForPending(ctx);
    clock += 5_000;
    await expect(decision).resolves.toMatchObject({
      decision: "rejected",
      rejectedBy: { type: "system", id: "ship-approval-timeout" },
    });
  });
});
