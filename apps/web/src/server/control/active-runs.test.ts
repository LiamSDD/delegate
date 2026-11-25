import type { PlanStep } from "@delegate/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type AppDatabase, createPgliteAppDatabase } from "../db";
import { appendEvent, type RunContext, STALE_AFTER_MS } from "../runs";
import { ACTIVE_RUNS_LIMIT, listActiveRuns } from "./active-runs";
import { countingApp, newGuest, newRun, type TestGuest } from "./testing";

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
    budgetShare: 0.5,
  },
  {
    id: "write",
    role: "editor",
    objective: "Write the brief",
    inputs: ["map"],
    capabilities: [],
    acceptance: ["ok"],
    budgetShare: 0.5,
  },
];

async function approvedPlan(ctx: RunContext) {
  await appendEvent(app, ctx, { type: "plan.proposed", payload: { version: 1, steps } });
  await appendEvent(app, ctx, {
    type: "plan.approved",
    payload: { version: 1, approvedBy: { type: "guest", id: ctx.userId } },
  });
}

async function usage(ctx: RunContext, inputTokens: number, outputTokens: number) {
  await appendEvent(app, ctx, {
    type: "usage.updated",
    payload: {
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costMicroUsd: 0,
      provider: "scripted",
      model: "scripted",
    },
  });
}

async function finish(ctx: RunContext) {
  await appendEvent(app, ctx, { type: "run.completed", payload: { summary: "done" } });
}

async function active(guest: TestGuest, now?: Date) {
  return listActiveRuns(app, guest.session, now);
}

describe("active runs in Mission Control", () => {
  it("is empty before anything runs", async () => {
    const guest = await newGuest(app);
    expect(await active(guest)).toEqual({ runs: [], truncated: false });
  });

  it("shows mission, target, status, current step, tokens and last activity", async () => {
    const guest = await newGuest(app);
    const other = await newGuest(app);
    const planning = await newRun(app, guest, {
      missionId: "automation-audit",
      input: { url: "https://www.acme.example/pricing" },
    });
    const waiting = await newRun(app, guest, {
      missionId: "custom-goal",
      input: { goal: "Cut support load" },
    });
    await appendEvent(app, waiting, { type: "plan.proposed", payload: { version: 1, steps } });
    const working = await newRun(app, guest, {
      missionId: "repo-xray",
      input: { url: "https://github.com/acme/widget" },
      execution: "simulated",
    });
    await approvedPlan(working);
    await appendEvent(app, working, { type: "step.started", stepId: "map", payload: {} });
    await usage(working, 1_200, 300);
    const between = await newRun(app, guest);
    await approvedPlan(between);
    await appendEvent(app, between, { type: "step.started", stepId: "map", payload: {} });
    await appendEvent(app, between, {
      type: "step.completed",
      stepId: "map",
      payload: { outcome: "succeeded", summary: "mapped", artifactIds: [] },
    });
    const done = await newRun(app, guest);
    await finish(done);
    await newRun(app, other);

    const { runs, truncated } = await active(guest);
    expect(truncated).toBe(false);
    expect(runs.map((run) => run.id)).toEqual([
      between.runId,
      working.runId,
      waiting.runId,
      planning.runId,
    ]);
    const byId = new Map(runs.map((run) => [run.id, run]));
    expect(byId.get(planning.runId)).toMatchObject({
      mission: "automation-audit",
      target: "acme.example",
      status: "planning",
      execution: "live",
      step: null,
      tokens: 0,
      children: [],
      stalled: false,
    });
    expect(byId.get(waiting.runId)).toMatchObject({
      target: "Cut support load",
      status: "awaiting_plan_approval",
      step: null,
    });
    expect(byId.get(working.runId)).toMatchObject({
      mission: "repo-xray",
      target: "acme/widget",
      status: "running",
      execution: "simulated",
      step: { id: "map", state: "running" },
      tokens: 1_500,
    });
    expect(byId.get(between.runId)?.step).toEqual({ id: "map", state: "finished" });
    for (const run of runs) expect(run.lastEventAt).toBeInstanceOf(Date);
  });

  it("nests the children of an active Autopilot run under it, finished ones included", async () => {
    const guest = await newGuest(app);
    const parent = await newRun(app, guest, {
      missionId: "autopilot",
      input: { goal: "Cut support load" },
    });
    const brief = await newRun(app, guest, {
      missionId: "custom-goal",
      input: { goal: "Cut support load" },
      parentRunId: parent.runId,
    });
    await usage(brief, 900, 100);
    await finish(brief);
    const xray = await newRun(app, guest, { parentRunId: parent.runId });
    await approvedPlan(xray);
    await appendEvent(app, xray, { type: "step.started", stepId: "write", payload: {} });

    const finishedParent = await newRun(app, guest, {
      missionId: "autopilot",
      input: { goal: "Old goal" },
    });
    const orphan = await newRun(app, guest, { parentRunId: finishedParent.runId });
    await finish(finishedParent);

    const { runs } = await active(guest);
    expect(runs.map((run) => run.id).sort()).toEqual([orphan.runId, parent.runId].sort());
    const shown = runs.find((run) => run.id === parent.runId);
    expect(shown?.children.map((child) => [child.id, child.mission, child.status])).toEqual([
      [brief.runId, "custom-goal", "completed"],
      [xray.runId, "company-xray", "running"],
    ]);
    expect(shown?.children[0]).toMatchObject({ tokens: 1_000 });
    expect(shown?.children[0]?.finishedAt).toBeInstanceOf(Date);
    expect(shown?.children[1]?.step).toEqual({ id: "write", state: "running" });
    expect(runs.find((run) => run.id === orphan.runId)?.children).toEqual([]);
  });

  it("marks a quiet run as stalled, but not one waiting for a person or an Autopilot parent", async () => {
    const guest = await newGuest(app);
    const quiet = await newRun(app, guest);
    await approvedPlan(quiet);
    const waiting = await newRun(app, guest);
    await appendEvent(app, waiting, { type: "plan.proposed", payload: { version: 1, steps } });
    const parent = await newRun(app, guest, {
      missionId: "autopilot",
      input: { goal: "Cut support load" },
    });
    const soon = new Date(Date.now() + STALE_AFTER_MS - 5_000);
    expect((await active(guest, soon)).runs.every((run) => !run.stalled)).toBe(true);
    const later = new Date(Date.now() + STALE_AFTER_MS + 60_000);
    const stalled = new Map((await active(guest, later)).runs.map((run) => [run.id, run.stalled]));
    expect(stalled.get(quiet.runId)).toBe(true);
    expect(stalled.get(waiting.runId)).toBe(false);
    expect(stalled.get(parent.runId)).toBe(false);
  });

  it("runs the same number of statements for two runs as for the full page, and says when it cut", async () => {
    const few = await newGuest(app);
    for (let index = 0; index < 2; index += 1) await newRun(app, few);
    const many = await newGuest(app);
    for (let index = 0; index < ACTIVE_RUNS_LIMIT + 1; index += 1) await newRun(app, many);

    const small = countingApp(app);
    const listedFew = await listActiveRuns(small.app, few.session);
    const large = countingApp(app);
    const listedMany = await listActiveRuns(large.app, many.session);

    expect(listedFew).toMatchObject({ truncated: false });
    expect(listedFew.runs).toHaveLength(2);
    expect(listedMany.truncated).toBe(true);
    expect(listedMany.runs).toHaveLength(ACTIVE_RUNS_LIMIT);
    expect(large.statements()).toBe(small.statements());
  });
});
