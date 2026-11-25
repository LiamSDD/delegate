import { auditLog, runs, withTenant } from "@delegate/db";
import {
  AUTOPILOT_REPORT_KIND,
  AutopilotReportSchema,
  type ChildStartedPayload,
  foldRun,
} from "@delegate/runtime";
import { goalBriefFixture, nextActionsFixture } from "@delegate/runtime/testing";
import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  type ApiDeps,
  CreateRunRequestSchema,
  handleCancelRun,
  handleCreateRun,
  handleForkRun,
  startRunForSession,
} from "../api";
import { createApiToken } from "../api-tokens";
import { launchChild } from "../autopilot";
import { type AppDatabase, createPgliteAppDatabase } from "../db";
import { handleMcp } from "../mcp-endpoint";
import type { MissionRunner } from "../mission-runner";
import { appendEvent, createRunRecord, getRunRecord, readAllEvents } from "../runs";
import { createRateLimiter } from "../session";
import { handleCreateShipRun } from "../ship-api";
import { readRunsPaused, setRunsPaused } from "../workspace-settings";
import { isRunsPausedError, RUNS_PAUSED_MESSAGE } from "./pause";
import { handleSetRunsPaused } from "./switches";
import {
  errorCode,
  jsonPost,
  newGuest,
  newRun,
  ORIGIN,
  type TestDeps,
  testDeps,
  type TestGuest,
} from "./testing";

let app: AppDatabase;

beforeAll(async () => {
  app = await createPgliteAppDatabase();
});

afterAll(async () => {
  await app.close();
});

const acme = { name: "Acme", url: "https://acme.example/" };

const improvement = {
  id: "imp-1",
  title: "Make sum handle empty lists",
  rationale: "sum([]) throws.",
  files: ["src/sum.js"],
  kind: "bugfix",
  effort: "S",
  acceptance: ["sum([]) returns 0"],
};

const briefRunner: MissionRunner = async (args) => {
  for (const artifact of [
    { kind: "goal-brief", title: "Goal brief", content: goalBriefFixture(acme) },
    {
      kind: "next-actions",
      title: "Next actions",
      content: nextActionsFixture([
        {
          id: "run-automation-audit",
          label: "Run AI Automation Audit",
          missionId: "automation-audit",
          input: { url: acme.url },
          available: true,
        },
      ]),
    },
  ])
    await args.emit({
      type: "artifact.created",
      payload: { artifactId: crypto.randomUUID(), version: 1, ...artifact },
    });
  await args.emit({ type: "run.completed", payload: { summary: "done" } });
  return { status: "completed" };
};

async function runCount(guest: TestGuest): Promise<number> {
  const [row] = await withTenant(app.db, guest.session.userId, (tx) =>
    tx.select({ n: count() }).from(runs).where(eq(runs.workspaceId, guest.session.workspaceId)),
  );
  return row?.n ?? 0;
}

async function pause(guest: TestGuest, paused = true) {
  const result = await setRunsPaused(app, guest.session, paused);
  expect(result.changed).toBe(true);
}

async function expectPaused(response: Response) {
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: { code: "runs_paused", message: RUNS_PAUSED_MESSAGE },
  });
}

const xray = { missionId: "company-xray", input: { url: "acme.com" } };

describe("the pause switch", () => {
  it("records who paused and resumed, and reports the state", async () => {
    const guest = await newGuest(app);
    expect(await readRunsPaused(app, guest.session)).toBeNull();
    const deps = testDeps(app);
    const paused = await handleSetRunsPaused(
      jsonPost("/control/pause", guest.cookie, { paused: true }),
      deps,
    );
    expect(paused.status).toBe(200);
    const body = z
      .object({ paused: z.boolean(), pausedAt: z.iso.datetime().nullable(), changed: z.boolean() })
      .parse(await paused.json());
    expect(body).toMatchObject({ paused: true, changed: true });
    expect((await readRunsPaused(app, guest.session))?.toISOString()).toBe(body.pausedAt);

    const again = await handleSetRunsPaused(
      jsonPost("/control/pause", guest.cookie, { paused: true }),
      deps,
    );
    expect(await again.json()).toMatchObject({ paused: true, changed: false });

    const resumed = await handleSetRunsPaused(
      jsonPost("/control/pause", guest.cookie, { paused: false }),
      deps,
    );
    expect(await resumed.json()).toEqual({ paused: false, pausedAt: null, changed: true });

    const audit = await withTenant(app.db, guest.session.userId, (tx) =>
      tx
        .select({ action: auditLog.action, actorId: auditLog.actorId, target: auditLog.target })
        .from(auditLog)
        .where(eq(auditLog.workspaceId, guest.session.workspaceId))
        .orderBy(auditLog.id),
    );
    expect(audit).toEqual([
      {
        action: "workspace.runs_paused",
        actorId: guest.session.userId,
        target: `workspace:${guest.session.workspaceId}`,
      },
      {
        action: "workspace.runs_resumed",
        actorId: guest.session.userId,
        target: `workspace:${guest.session.workspaceId}`,
      },
    ]);
  });

  it("is refused across origins, with an API token, without a session and for bad input", async () => {
    const guest = await newGuest(app);
    const deps = testDeps(app);
    const crossSite = await handleSetRunsPaused(
      jsonPost(
        "/control/pause",
        guest.cookie,
        { paused: true },
        { origin: "https://evil.example" },
      ),
      deps,
    );
    expect(crossSite.status).toBe(403);
    const { token } = await createApiToken(app, guest.session, "cli");
    const bearer = await handleSetRunsPaused(
      jsonPost("/control/pause", null, { paused: true }, { authorization: `Bearer ${token}` }),
      deps,
    );
    expect(bearer.status).toBe(403);
    const anonymous = await handleSetRunsPaused(
      jsonPost("/control/pause", null, { paused: true }),
      deps,
    );
    expect(anonymous.status).toBe(404);
    const invalid = await handleSetRunsPaused(
      jsonPost("/control/pause", guest.cookie, { paused: "yes" }),
      deps,
    );
    expect(invalid.status).toBe(400);
    expect(await readRunsPaused(app, guest.session)).toBeNull();
  });
});

describe("a paused workspace starts no run on any path", () => {
  it("web: POST /api/runs answers 409 and spends no guest quota", async () => {
    const guest = await newGuest(app);
    await pause(guest);
    const deps = testDeps(app, {
      guestLimiter: createRateLimiter({ limit: 1, windowMs: 3_600_000 }),
    });
    for (const body of [xray, { missionId: "autopilot", input: { goal: "Cut support load" } }])
      await expectPaused(await handleCreateRun(jsonPost("/api/runs", guest.cookie, body), deps));
    expect(await runCount(guest)).toBe(0);
    expect(deps.tasks).toHaveLength(0);

    await pause(guest, false);
    const started = await handleCreateRun(jsonPost("/api/runs", guest.cookie, xray), deps);
    expect(started.status).toBe(201);
    expect(await runCount(guest)).toBe(1);
  });

  it("bearer API: POST /api/runs with a token answers 409", async () => {
    const guest = await newGuest(app);
    const { token } = await createApiToken(app, guest.session, "cli");
    await pause(guest);
    const deps = testDeps(app);
    const response = await handleCreateRun(
      new Request(`${ORIGIN}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(xray),
      }),
      deps,
    );
    await expectPaused(response);
    expect(await runCount(guest)).toBe(0);
  });

  it("MCP: start_mission and start_autopilot return the same message as an error", async () => {
    const guest = await newGuest(app);
    const { token } = await createApiToken(app, guest.session, "claude-code");
    await pause(guest);
    const deps = testDeps(app);
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await handleMcp(
        new Request(`${ORIGIN}/api/mcp`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-06-18",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: args },
          }),
        }),
        deps,
        createRateLimiter({ limit: 100, windowMs: 3_600_000 }),
      );
      expect(response.status).toBe(200);
      return z
        .object({
          result: z.object({
            content: z.array(z.object({ text: z.string() })),
            isError: z.boolean().optional(),
          }),
        })
        .parse(await response.json()).result;
    };
    const mission = await call("start_mission", {
      missionId: "company-xray",
      input: { url: "acme.com" },
    });
    expect(mission.isError).toBe(true);
    expect(mission.content[0]?.text).toContain(RUNS_PAUSED_MESSAGE);
    const autopilot = await call("start_autopilot", { goal: "Cut support load" });
    expect(autopilot.isError).toBe(true);
    expect(autopilot.content[0]?.text).toContain(RUNS_PAUSED_MESSAGE);
    expect(await runCount(guest)).toBe(0);
    expect(deps.tasks).toHaveLength(0);
  });

  it("fork: POST /api/runs/[id]/fork answers 409", async () => {
    const guest = await newGuest(app);
    const deps = testDeps(app);
    const created = await handleCreateRun(
      jsonPost("/api/runs", `${guest.cookie}; delegate_auto_approve=1`, xray),
      deps,
    );
    const { runId } = (await created.json()) as { runId: string };
    await deps.tasks.shift()?.();
    expect((await getRunRecord(app, guest.session.userId, runId))?.status).toBe("completed");
    await pause(guest);
    await expectPaused(
      await handleForkRun(
        jsonPost(`/api/runs/${runId}/fork`, guest.cookie, { stepId: "read-pages" }),
        runId,
        deps,
      ),
    );
    expect(await runCount(guest)).toBe(1);

    await pause(guest, false);
    const forked = await handleForkRun(
      jsonPost(`/api/runs/${runId}/fork`, guest.cookie, { stepId: "read-pages" }),
      runId,
      deps,
    );
    expect(forked.status).toBe(201);
  });

  it("Ship-a-PR: POST /api/ship answers 409", async () => {
    const guest = await newGuest(app);
    await pause(guest);
    const deps = testDeps(app, {
      shipEnabled: true,
      runner: () => ({ execution: "live", run: briefRunner }),
    });
    await expectPaused(
      await handleCreateShipRun(
        jsonPost("/api/ship", guest.cookie, {
          repoUrl: "https://github.com/acme/widgets",
          improvement,
        }),
        deps,
      ),
    );
    expect(await runCount(guest)).toBe(0);
    expect(deps.tasks).toHaveLength(0);
  });

  it("Autopilot: stops before the next child and says why in its report", async () => {
    const guest = await newGuest(app);
    const deps = testDeps(app, { runner: () => ({ execution: "live", run: briefRunner }) });
    const started = await startRunForSession(
      app,
      guest.session,
      CreateRunRequestSchema.parse({
        missionId: "autopilot",
        input: { goal: "Cut support load", url: "acme.example" },
      }),
      deps,
      { autoApprovePlan: false },
    );
    if (!started.ok) throw new Error("autopilot did not start");
    await deps.tasks.shift()?.();
    expect(await runCount(guest)).toBe(2);
    await pause(guest);
    while (deps.tasks.length > 0) await deps.tasks.shift()?.();

    const events = await readAllEvents(app, guest.session.userId, started.runId);
    const state = foldRun(events);
    expect(state.status).toBe("completed");
    expect(state.children.map((child) => child.nodeId)).toEqual(["brief"]);
    const report = events.find(
      (event) => event.type === "artifact.created" && event.payload.kind === AUTOPILOT_REPORT_KIND,
    );
    if (report?.type !== "artifact.created") throw new Error("no report");
    const parsed = AutopilotReportSchema.parse(report.payload.content);
    expect(parsed.status).toBe("stopped");
    expect(parsed.stop?.reason).toBe("unavailable");
    expect(parsed.stop?.message).toContain("new runs are paused for this workspace");
    expect(parsed.stop?.message).toContain("Company X-ray");
    expect(await runCount(guest)).toBe(2);
  });

  it("Autopilot: a child that was announced but not created stays uncreated while paused", async () => {
    const guest = await newGuest(app);
    const deps = testDeps(app, { runner: () => ({ execution: "live", run: briefRunner }) });
    const parent = await newRun(app, guest, {
      missionId: "autopilot",
      input: { goal: "Cut support load" },
    });
    const child: ChildStartedPayload = {
      childRunId: crypto.randomUUID(),
      nodeId: "brief",
      missionId: "custom-goal",
      label: "Goal brief",
      input: { goal: "Cut support load" },
      approvals: { plan: "human", sideEffects: "none" },
    };
    await appendEvent(app, parent, { type: "child.started", payload: child });
    await pause(guest);
    await launchChild(app, parent, child, deps);
    expect(await getRunRecord(app, guest.session.userId, child.childRunId)).toBeNull();
    expect(deps.tasks).toHaveLength(0);

    const cancelled = await handleCancelRun(
      jsonPost(`/api/runs/${parent.runId}/cancel`, guest.cookie, {}),
      parent.runId,
      deps,
    );
    expect(cancelled.status).toBe(200);
    expect(await getRunRecord(app, guest.session.userId, child.childRunId)).toBeNull();

    await pause(guest, false);
    const resumedParent = await newRun(app, guest, {
      missionId: "autopilot",
      input: { goal: "Cut support load" },
    });
    const next = { ...child, childRunId: crypto.randomUUID() };
    await appendEvent(app, resumedParent, { type: "child.started", payload: next });
    await launchChild(app, resumedParent, next, deps);
    expect((await getRunRecord(app, guest.session.userId, next.childRunId))?.mission).toBe(
      "custom-goal",
    );
  });

  it("answers 409, not 500, when the pause lands between the check and the insert", async () => {
    const guest = await newGuest(app);
    let pausing: Promise<unknown> | undefined;
    const racing = (base: TestDeps): ApiDeps => ({
      ...base,
      runner: () => {
        pausing ??= setRunsPaused(app, guest.session, true);
        return base.runner();
      },
    });
    const deps = testDeps(app);
    await expectPaused(
      await handleCreateRun(jsonPost("/api/runs", guest.cookie, xray), racing(deps)),
    );
    await pausing;
    expect(await runCount(guest)).toBe(0);
    expect(deps.tasks).toHaveLength(0);

    let failure: unknown;
    try {
      await createRunRecord(app, guest.session, {
        missionId: "company-xray",
        input: { url: "https://acme.example/" },
        execution: "live",
      });
    } catch (error: unknown) {
      failure = error;
    }
    expect(isRunsPausedError(failure)).toBe(true);
    expect(isRunsPausedError(new Error("something else"))).toBe(false);
  });

  it("leaves running work alone", async () => {
    const guest = await newGuest(app);
    const ctx = await newRun(app, guest);
    await pause(guest);
    await appendEvent(app, ctx, { type: "run.completed", payload: { summary: "finished" } });
    expect((await getRunRecord(app, guest.session.userId, ctx.runId))?.status).toBe("completed");
  });
});
