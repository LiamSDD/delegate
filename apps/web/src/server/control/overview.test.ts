import type { PlanStep } from "@delegate/runtime";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { MissionControlView } from "@/components/control/mission-control";

import { type AppDatabase, createPgliteAppDatabase } from "../db";
import { createPlanApprovalWaiter } from "../plan-approval";
import { appendEvent, type RunContext } from "../runs";
import { setRunsPaused } from "../workspace-settings";
import { emptyMissionControl, missionControl } from "./overview";
import { countingApp, newGuest, newRun, type TestGuest } from "./testing";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, refresh: () => undefined }),
}));

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
    capabilities: ["web.fetch"],
    acceptance: ["ok"],
    budgetShare: 1,
  },
];

const A_DAY_MS = 24 * 60 * 60_000;
let clockSkewMs = 0;

function waitForPlan(ctx: RunContext) {
  return createPlanApprovalWaiter({
    app,
    ctx,
    autoApprove: false,
    pollMs: 5,
    now: () => Date.now() + clockSkewMs,
  })({ version: 1, steps, kind: "initial" });
}

async function pendingPlan(guest: TestGuest) {
  const giveUpAt = Date.now() + 20_000;
  while (Date.now() < giveUpAt) {
    const control = await missionControl(app, guest.session);
    if (control.inbox.items.length > 0) return control;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the plan approval never appeared");
}

function render(control: Awaited<ReturnType<typeof missionControl>>): string {
  return renderToString(createElement(MissionControlView, { control }));
}

describe("the Mission Control read", () => {
  it("is the empty page, with a workspace, for a visitor who has run nothing", async () => {
    const guest = await newGuest(app);
    const now = new Date();
    const control = await missionControl(app, guest.session, now);
    expect(control).toEqual({ ...emptyMissionControl(now), hasWorkspace: true });
    const html = render(control);
    expect(html.split("data-empty-state").length - 1).toBe(3);
    expect(html).not.toContain("This browser has no workspace yet");
  });

  it("gathers runs, approvals, usage and the switches for one workspace and nothing of another", async () => {
    const guest = await newGuest(app);
    const other = await newGuest(app);
    const working = await newRun(app, guest, { input: { url: "https://working.example/" } });
    await appendEvent(app, working, { type: "plan.proposed", payload: { version: 1, steps } });
    await appendEvent(app, working, {
      type: "usage.updated",
      payload: {
        inputTokens: 1_200,
        outputTokens: 300,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costMicroUsd: 0,
        provider: "scripted",
        model: "scripted",
      },
    });
    const waiting = await newRun(app, guest, {
      missionId: "automation-audit",
      input: { url: "https://waiting.example/" },
    });
    const theirs = await newRun(app, other, { input: { url: "https://theirs.example/" } });
    const outstanding = [waitForPlan(waiting), waitForPlan(theirs)];
    await setRunsPaused(app, guest.session, true);

    const control = await pendingPlan(guest);
    expect(control.hasWorkspace).toBe(true);
    expect(control.runsPausedAt).toBeInstanceOf(Date);
    expect(control.active.runs.map((run) => run.id).sort()).toEqual(
      [working.runId, waiting.runId].sort(),
    );
    expect(control.inbox.items).toMatchObject([{ kind: "plan", runId: waiting.runId, steps }]);
    expect(control.usage.quota).toMatchObject({ lastHour: 2, today: 2 });
    expect(control.usage.missions).toContainEqual({
      mission: "company-xray",
      runs: 1,
      inputTokens: 1_200,
      outputTokens: 300,
    });
    expect(control.switchActivity).toMatchObject([{ action: "workspace.runs_paused" }]);
    expect(control.decisions.entries).toEqual([]);

    const html = render(control);
    expect(html).toContain("working.example");
    expect(html).toContain("waiting.example");
    expect(html).toContain("Approve these steps");
    expect(html).toContain("data-paused-banner");
    expect(html).toContain(`href="/runs/${waiting.runId}"`);
    expect(html).not.toContain("theirs.example");
    expect(html).not.toContain(theirs.runId);

    const elsewhere = await missionControl(app, other.session);
    expect(elsewhere.runsPausedAt).toBeNull();
    expect(elsewhere.active.runs.map((run) => run.id)).toEqual([theirs.runId]);
    expect(elsewhere.switchActivity).toEqual([]);

    clockSkewMs = A_DAY_MS;
    await Promise.all(outstanding);
    clockSkewMs = 0;
  });

  it("runs the same number of statements for one run as for twenty", async () => {
    const one = await newGuest(app);
    await newRun(app, one);
    const twenty = await newGuest(app);
    for (let index = 0; index < 20; index += 1) await newRun(app, twenty);

    const small = countingApp(app);
    await missionControl(small.app, one.session);
    const large = countingApp(app);
    const control = await missionControl(large.app, twenty.session);

    expect(control.active.runs).toHaveLength(20);
    expect(large.statements()).toBe(small.statements());
  });
});
