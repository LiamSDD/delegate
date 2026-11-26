import { auditLog, withTenant } from "@delegate/db";
import type { ChildStartedPayload } from "@delegate/runtime";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { handleCancelRun } from "../api";
import { createApiToken } from "../api-tokens";
import { type AppDatabase, createPgliteAppDatabase } from "../db";
import { appendEvent, getRunRecord, readAllEvents } from "../runs";
import { setRunsPaused } from "../workspace-settings";
import { listActiveRuns } from "./active-runs";
import {
  handleStopAllRuns,
  recentSwitchActivity,
  RUNS_STOPPED_ACTION,
  STOP_ALL_CONFIRMATION,
} from "./switches";
import { jsonPost, newGuest, newRun, type TestGuest, testDeps } from "./testing";

let app: AppDatabase;

beforeAll(async () => {
  app = await createPgliteAppDatabase();
});

afterAll(async () => {
  await app.close();
});

const confirm = { confirm: STOP_ALL_CONFIRMATION };

async function lastEvent(guest: TestGuest, runId: string) {
  return (await readAllEvents(app, guest.session.userId, runId)).at(-1);
}

async function stopAudit(guest: TestGuest) {
  return withTenant(app.db, guest.session.userId, (tx) =>
    tx
      .select({ action: auditLog.action, details: auditLog.details, actorId: auditLog.actorId })
      .from(auditLog)
      .where(eq(auditLog.workspaceId, guest.session.workspaceId)),
  );
}

describe("stop all active runs", () => {
  it("cancels every active run the way the cancel route does, and nothing else", async () => {
    const guest = await newGuest(app);
    const other = await newGuest(app);
    const deps = testDeps(app);

    const single = await newRun(app, guest);
    const executing = await newRun(app, guest, { missionId: "repo-xray" });
    const signal = deps.registry.register(executing.runId).signal;
    const parent = await newRun(app, guest, {
      missionId: "autopilot",
      input: { goal: "Cut support load" },
    });
    const child = await newRun(app, guest, { parentRunId: parent.runId });
    const started: ChildStartedPayload = {
      childRunId: child.runId,
      nodeId: "brief",
      missionId: "custom-goal",
      label: "Goal brief",
      input: { goal: "Cut support load" },
      approvals: { plan: "human", sideEffects: "none" },
    };
    await appendEvent(app, parent, { type: "child.started", payload: started });
    const finished = await newRun(app, guest);
    await appendEvent(app, finished, { type: "run.completed", payload: { summary: "done" } });
    const foreign = await newRun(app, other);

    const reference = await newRun(app, other, { missionId: "automation-audit" });
    await handleCancelRun(
      jsonPost(`/api/runs/${reference.runId}/cancel`, other.cookie, {}),
      reference.runId,
      deps,
    );
    const cancelled = await lastEvent(other, reference.runId);

    const response = await handleStopAllRuns(
      jsonPost("/control/stop-all", guest.cookie, confirm),
      deps,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { stopped: number; runIds: string[] };
    expect(body.stopped).toBe(4);
    expect(body.runIds.sort()).toEqual(
      [single.runId, executing.runId, parent.runId, child.runId].sort(),
    );

    for (const runId of [single.runId, executing.runId, parent.runId]) {
      const event = await lastEvent(guest, runId);
      expect(event?.type).toBe("run.failed");
      expect(event?.payload).toEqual(cancelled?.payload);
    }
    expect((await lastEvent(guest, child.runId))?.payload).toMatchObject({
      error: { code: "cancelled" },
    });
    expect(signal.aborted).toBe(true);
    expect(deps.registry.has(executing.runId)).toBe(false);
    expect((await listActiveRuns(app, guest.session)).runs).toEqual([]);

    expect((await getRunRecord(app, guest.session.userId, finished.runId))?.status).toBe(
      "completed",
    );
    expect((await getRunRecord(app, other.session.userId, foreign.runId))?.status).toBe("planning");

    const audit = await stopAudit(guest);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: RUNS_STOPPED_ACTION,
      actorId: guest.session.userId,
      details: { activeRuns: 4 },
    });
    expect((audit[0]?.details as { runIds: string[] }).runIds.sort()).toEqual(body.runIds.sort());
  });

  it("does nothing and writes no audit row when nothing is active", async () => {
    const guest = await newGuest(app);
    const response = await handleStopAllRuns(
      jsonPost("/control/stop-all", guest.cookie, confirm),
      testDeps(app),
    );
    expect(await response.json()).toEqual({ stopped: 0, runIds: [] });
    expect(await stopAudit(guest)).toEqual([]);
  });

  it("needs the confirmation, the same origin and a browser session", async () => {
    const guest = await newGuest(app);
    const run = await newRun(app, guest);
    const deps = testDeps(app);
    const { token } = await createApiToken(app, guest.session, "cli");
    const refused = [
      [jsonPost("/control/stop-all", guest.cookie, {}), 400],
      [jsonPost("/control/stop-all", guest.cookie, { confirm: "yes" }), 400],
      [
        jsonPost("/control/stop-all", guest.cookie, confirm, { origin: "https://evil.example" }),
        403,
      ],
      [jsonPost("/control/stop-all", null, confirm, { authorization: `Bearer ${token}` }), 403],
      [jsonPost("/control/stop-all", null, confirm), 404],
    ] as const;
    for (const [request, status] of refused)
      expect((await handleStopAllRuns(request, deps)).status).toBe(status);
    expect((await getRunRecord(app, guest.session.userId, run.runId))?.status).toBe("planning");
  });

  it("another visitor's stop-all leaves this workspace running", async () => {
    const guest = await newGuest(app);
    const stranger = await newGuest(app);
    const run = await newRun(app, guest);
    await newRun(app, stranger);
    const response = await handleStopAllRuns(
      jsonPost("/control/stop-all", stranger.cookie, confirm),
      testDeps(app),
    );
    expect(await response.json()).toMatchObject({ stopped: 1 });
    expect((await getRunRecord(app, guest.session.userId, run.runId))?.status).toBe("planning");
  });
});

describe("switch activity", () => {
  it("lists pauses, resumes and stops newest first", async () => {
    const guest = await newGuest(app);
    expect(await recentSwitchActivity(app, guest.session)).toEqual([]);
    await setRunsPaused(app, guest.session, true);
    await setRunsPaused(app, guest.session, false);
    await newRun(app, guest);
    await newRun(app, guest);
    await handleStopAllRuns(jsonPost("/control/stop-all", guest.cookie, confirm), testDeps(app));
    const activity = await recentSwitchActivity(app, guest.session);
    expect(activity.map((entry) => [entry.action, entry.runs])).toEqual([
      ["workspace.runs_stopped", 2],
      ["workspace.runs_resumed", null],
      ["workspace.runs_paused", null],
    ]);
    expect(activity.every((entry) => entry.at instanceof Date)).toBe(true);
    expect(await recentSwitchActivity(app, guest.session, 1)).toHaveLength(1);
  });
});
