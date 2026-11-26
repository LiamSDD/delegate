import type { PlanStep, RunEvent } from "@delegate/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { handleCreateRun, handleForkRun } from "../api";
import { type AppDatabase, createPgliteAppDatabase } from "../db";
import { appendEvent, readAllEvents, type RunContext } from "../runs";
import { GUEST_RUNS_PER_HOUR } from "../session";
import { countingApp, jsonPost, newGuest, newRun, testDeps } from "./testing";
import { emptyUsage, USAGE_WINDOW_DAYS, VERCEL_SANDBOX_HOBBY, workspaceUsage } from "./usage";

let app: AppDatabase;

beforeAll(async () => {
  app = await createPgliteAppDatabase();
});

afterAll(async () => {
  await app.close();
});

const DAY_MS = 24 * 60 * 60 * 1000;

const steps: PlanStep[] = [
  {
    id: "work",
    role: "researcher",
    objective: "Do the work",
    inputs: [],
    capabilities: ["web.fetch"],
    acceptance: ["ok"],
    budgetShare: 1,
  },
];

async function startWork(ctx: RunContext) {
  await appendEvent(app, ctx, { type: "plan.proposed", payload: { version: 1, steps } });
  await appendEvent(app, ctx, {
    type: "plan.approved",
    payload: { version: 1, approvedBy: { type: "guest", id: ctx.userId } },
  });
  await appendEvent(app, ctx, { type: "step.started", stepId: "work", payload: {} });
}

async function tokens(ctx: RunContext, inputTokens: number, outputTokens: number) {
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

async function fallback(ctx: RunContext, reason: "rate_limited" | "timeout", exhausted = false) {
  await appendEvent(app, ctx, {
    type: "model.fallback",
    payload: {
      role: "worker",
      from: { provider: "a", model: "one" },
      to: exhausted ? null : { provider: "b", model: "two" },
      reason,
    },
  });
}

async function sandbox(ctx: RunContext, durationMs: number) {
  await appendEvent(app, ctx, {
    type: "sandbox.command",
    stepId: "work",
    payload: {
      commandId: crypto.randomUUID(),
      purpose: "verify",
      command: "pnpm test",
      exitCode: 0,
      durationMs,
      timedOut: false,
      output: "ok",
      truncated: false,
    },
  });
}

async function toolResult(ctx: RunContext, tool: string, ok: boolean, summary: string) {
  await appendEvent(app, ctx, {
    type: "tool.result",
    stepId: "work",
    payload: { toolCallId: crypto.randomUUID(), tool, ok, summary, durationMs: 10 },
  });
}

function ownUsage(events: readonly RunEvent[]): number {
  const created = events[0];
  const seeded =
    created?.type === "run.created" ? (created.payload.forkedFrom?.seededThrough ?? 0) : 0;
  return events.reduce(
    (sum, event) =>
      event.type === "usage.updated" && event.seq > seeded
        ? sum + event.payload.inputTokens + event.payload.outputTokens
        : sum,
    0,
  );
}

describe("usage and limits", () => {
  it("is all zeros, with the windows stated, for a workspace that has not run anything", async () => {
    const guest = await newGuest(app);
    const now = new Date("2026-11-25T15:30:00.000Z");
    const usage = await workspaceUsage(app, guest.session, now);
    expect(usage).toEqual(emptyUsage(now));
    expect(usage.windowDays).toBe(USAGE_WINDOW_DAYS);
    expect(usage.since.toISOString()).toBe("2026-11-18T15:30:00.000Z");
    expect(usage.quota).toEqual({
      limitPerHour: GUEST_RUNS_PER_HOUR,
      lastHour: 0,
      today: 0,
      dayStart: new Date("2026-11-25T00:00:00.000Z"),
    });
  });

  it("names the Vercel sandbox allowance with its source", () => {
    expect(VERCEL_SANDBOX_HOBBY).toEqual({
      activeCpuHoursPerMonth: 5,
      source: "https://vercel.com/docs/sandbox/pricing",
      checkedOn: "2026-11-25",
    });
  });

  it("sums tokens by mission, fallbacks, sandbox seconds and crawled pages from events", async () => {
    const guest = await newGuest(app);
    const other = await newGuest(app);
    const audit = await newRun(app, guest, { missionId: "automation-audit" });
    await startWork(audit);
    await tokens(audit, 1_000, 200);
    await tokens(audit, 500, 50);
    await fallback(audit, "rate_limited");
    await fallback(audit, "rate_limited", true);
    await fallback(audit, "timeout");
    await toolResult(
      audit,
      "crawl_site",
      true,
      "Crawled 12 pages of acme.example in 3.4 s (2 skipped, stop: budget); kept 8 for reading",
    );
    await toolResult(audit, "crawl_site", true, "Crawled 1 page of tiny.example in 0.2 s");
    await toolResult(audit, "crawl_site", true, "A summary in a format this page does not know");
    await toolResult(audit, "crawl_site", false, "crawl_site failed");
    await toolResult(audit, "fetch_page", true, "GET https://acme.example/pricing");

    const build = await newRun(app, guest, { missionId: "build-agent" });
    await startWork(build);
    await tokens(build, 300, 30);
    for (let page = 0; page < 3; page += 1)
      await toolResult(build, "crawl_page", true, "200 text/html 1200 bytes");
    await toolResult(build, "crawl_page", false, "crawl_page failed");

    const ship = await newRun(app, guest, { missionId: "ship-a-pr" });
    await startWork(ship);
    await sandbox(ship, 1_250);
    await sandbox(ship, 2_500);

    await newRun(app, guest, { missionId: "autopilot", input: { goal: "Cut support load" } });

    const foreign = await newRun(app, other, { missionId: "automation-audit" });
    await startWork(foreign);
    await tokens(foreign, 9_999, 9_999);
    await sandbox(foreign, 60_000);
    await fallback(foreign, "timeout");

    const usage = await workspaceUsage(app, guest.session);
    expect(usage.missions).toEqual([
      { mission: "automation-audit", runs: 1, inputTokens: 1_500, outputTokens: 250 },
      { mission: "build-agent", runs: 1, inputTokens: 300, outputTokens: 30 },
      { mission: "autopilot", runs: 1, inputTokens: 0, outputTokens: 0 },
      { mission: "ship-a-pr", runs: 1, inputTokens: 0, outputTokens: 0 },
    ]);
    expect(usage.fallbacks).toEqual({
      total: 3,
      exhausted: 1,
      byReason: [
        { reason: "rate_limited", count: 2 },
        { reason: "timeout", count: 1 },
      ],
    });
    expect(usage.sandbox).toEqual({ commands: 2, seconds: 3.8 });
    expect(usage.crawl).toEqual({ pages: 16, siteCrawls: 3, uncountedCrawls: 1 });
    expect(usage.quota).toMatchObject({ lastHour: 3, today: 4, limitPerHour: GUEST_RUNS_PER_HOUR });
  });

  it("keeps the windows: nothing older than seven days, the quota over sixty minutes", async () => {
    const guest = await newGuest(app);
    const run = await newRun(app, guest);
    await startWork(run);
    await tokens(run, 100, 10);
    await sandbox(run, 1_000);

    const inTwoHours = await workspaceUsage(
      app,
      guest.session,
      new Date(Date.now() + 2 * 3_600_000),
    );
    expect(inTwoHours.quota.lastHour).toBe(0);
    expect(inTwoHours.missions).toEqual([
      { mission: "company-xray", runs: 1, inputTokens: 100, outputTokens: 10 },
    ]);

    const nextWeek = await workspaceUsage(
      app,
      guest.session,
      new Date(Date.now() + (USAGE_WINDOW_DAYS + 1) * DAY_MS),
    );
    expect(nextWeek.missions).toEqual([]);
    expect(nextWeek.sandbox).toEqual({ commands: 0, seconds: 0 });
    expect(nextWeek.quota).toMatchObject({ lastHour: 0, today: 0 });
  });

  it("does not count the events a fork was seeded with a second time", async () => {
    const guest = await newGuest(app);
    const deps = testDeps(app);
    const created = await handleCreateRun(
      jsonPost("/api/runs", `${guest.cookie}; delegate_auto_approve=1`, {
        missionId: "company-xray",
        input: { url: "acme.com" },
      }),
      deps,
    );
    const { runId } = (await created.json()) as { runId: string };
    await deps.tasks.shift()?.();
    const forked = await handleForkRun(
      jsonPost(`/api/runs/${runId}/fork`, guest.cookie, { stepId: "read-pages" }),
      runId,
      deps,
    );
    expect(forked.status).toBe(201);
    const fork = (await forked.json()) as { runId: string; seededEvents: number };
    expect(fork.seededEvents).toBeGreaterThan(0);
    await deps.tasks.shift()?.();

    const parentEvents = await readAllEvents(app, guest.session.userId, runId);
    const forkEvents = await readAllEvents(app, guest.session.userId, fork.runId);
    const expected = ownUsage(parentEvents) + ownUsage(forkEvents);
    const naive =
      ownUsage(parentEvents) +
      forkEvents.reduce(
        (sum, event) =>
          event.type === "usage.updated"
            ? sum + event.payload.inputTokens + event.payload.outputTokens
            : sum,
        0,
      );
    expect(expected).toBeGreaterThan(0);
    expect(naive).toBeGreaterThan(expected);

    const usage = await workspaceUsage(app, guest.session);
    expect(usage.missions).toHaveLength(1);
    const [mission] = usage.missions;
    expect(mission).toMatchObject({ mission: "company-xray", runs: 2 });
    expect((mission?.inputTokens ?? 0) + (mission?.outputTokens ?? 0)).toBe(expected);
  });

  it("runs the same number of statements whatever the number of runs", async () => {
    const few = await newGuest(app);
    await newRun(app, few);
    const many = await newGuest(app);
    for (let index = 0; index < 12; index += 1) {
      const run = await newRun(app, many, {
        missionId: index % 2 === 0 ? "repo-xray" : "custom-goal",
      });
      await startWork(run);
      await tokens(run, 10, 1);
    }
    const small = countingApp(app);
    await workspaceUsage(small.app, few.session);
    const large = countingApp(app);
    const usage = await workspaceUsage(large.app, many.session);
    expect(usage.missions.map((mission) => mission.runs)).toEqual([6, 6]);
    expect(large.statements()).toBe(small.statements());
  });
});
