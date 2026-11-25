import {
  AUTOPILOT_REPORT_KIND,
  AutopilotReportSchema,
  type ChildStartedPayload,
  foldRun,
  type RunEvent,
} from "@delegate/runtime";
import {
  assistantFixture,
  auditFixture,
  goalBriefFixture,
  nextActionsFixture,
  repoXrayFixture,
  shipResultFixture,
} from "@delegate/runtime/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type ApiDeps,
  CreateRunRequestSchema,
  handleCancelRun,
  handleRunChildren,
  startRunForSession,
} from "./api";
import { type AutopilotGraphNode, launchChild } from "./autopilot";
import { type AppDatabase, createPgliteAppDatabase } from "./db";
import { reviveOrSweep } from "./durable";
import { storeInstallation } from "./github-connect";
import type { MissionRunArgs, MissionRunner } from "./mission-runner";
import { createRunRegistry } from "./run-registry";
import { appendEvent, getRunRecord, readAllEvents } from "./runs";
import { createRateLimiter, type GuestSession, resolveGuest, signSession } from "./session";
import { updateAutomation } from "./workspace-settings";

const ORIGIN = "http://localhost:3000";
const secret = "s".repeat(32);
const acme = { name: "Acme", url: "https://acme.example/" };
const REPO = "https://github.com/acme/widget";

let app: AppDatabase;

beforeAll(async () => {
  app = await createPgliteAppDatabase();
});

afterAll(async () => {
  await app.close();
});

type Track = "company" | "repo";

interface Script {
  track?: Track;
  fail?: string;
  tokensPerChild?: number;
}

function deliverables(args: MissionRunArgs, track: Track) {
  switch (args.missionId) {
    case "custom-goal":
      return [
        { kind: "goal-brief", title: "Goal brief", content: goalBriefFixture(acme) },
        {
          kind: "next-actions",
          title: "Next actions",
          content: nextActionsFixture(
            track === "repo"
              ? [
                  {
                    id: "ship-via-repo-xray",
                    label: "Ship a PR: X-ray the repository first",
                    missionId: "repo-xray",
                    input: { url: REPO },
                    available: true,
                  },
                ]
              : [
                  {
                    id: "run-automation-audit",
                    label: "Run AI Automation Audit",
                    missionId: "automation-audit",
                    input: { url: acme.url },
                    available: true,
                  },
                ],
          ),
        },
      ];
    case "company-xray":
      return [
        { kind: "company-xray-brief", title: "X-ray", content: { company: acme, sources: [] } },
      ];
    case "automation-audit":
      return [{ kind: "automation-audit", title: "Audit", content: auditFixture() }];
    case "build-agent":
      return [{ kind: "assistant", title: "Assistant", content: assistantFixture() }];
    case "repo-xray":
      return [{ kind: "repo-xray", title: "Repo X-ray", content: repoXrayFixture() }];
    case "ship-a-pr":
      return [
        {
          kind: "ship-result",
          title: "Ship result",
          content: shipResultFixture(
            args.findInstallation === undefined ? "patch_ready" : "opened",
          ),
        },
      ];
  }
}

function scriptedRunner(seen: MissionRunArgs[], script: Script = {}): MissionRunner {
  return async (args) => {
    seen.push(args);
    await args.emit({
      type: "usage.updated",
      payload: {
        inputTokens: script.tokensPerChild ?? 1_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costMicroUsd: 0,
        provider: "scripted",
        model: "scripted",
      },
    });
    if (script.fail === args.missionId) {
      await args.emit({
        type: "run.failed",
        payload: { error: { code: "mission_failed", message: "The site refused every fetch." } },
      });
      return { status: "failed" };
    }
    for (const artifact of deliverables(args, script.track ?? "company"))
      await args.emit({
        type: "artifact.created",
        payload: { artifactId: crypto.randomUUID(), version: 1, ...artifact },
      });
    await args.emit({
      type: "run.completed",
      payload: { summary: `${args.missionId} finished.` },
    });
    return { status: "completed" };
  };
}

interface Harness {
  deps: ApiDeps;
  tasks: (() => Promise<void>)[];
  seen: MissionRunArgs[];
  session: GuestSession;
}

async function harness(script: Script = {}, overrides: Partial<ApiDeps> = {}): Promise<Harness> {
  const tasks: (() => Promise<void>)[] = [];
  const seen: MissionRunArgs[] = [];
  const { session } = await resolveGuest(app, undefined, secret);
  const run = scriptedRunner(seen, script);
  return {
    tasks,
    seen,
    session,
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
      shipEnabled: true,
      shipInstallations: () => () => Promise.resolve({ installationId: 1, collaborator: "octo" }),
      ...overrides,
    },
  };
}

async function drain(h: Harness, limit = 20): Promise<void> {
  for (let index = 0; index < limit && h.tasks.length > 0; index += 1) {
    const task = h.tasks.shift();
    if (task !== undefined) await task();
  }
}

async function startAutopilot(h: Harness, input: { goal: string; url?: string }): Promise<string> {
  const request = CreateRunRequestSchema.parse({ missionId: "autopilot", input });
  const started = await startRunForSession(app, h.session, request, h.deps, {
    autoApprovePlan: false,
  });
  if (!started.ok) throw new Error(`start failed: ${String(started.response.status)}`);
  return started.runId;
}

async function parentState(h: Harness, runId: string) {
  const events = await readAllEvents(app, h.session.userId, runId);
  return { events, state: foldRun(events) };
}

function reportOf(events: readonly RunEvent[]) {
  const created = events.find(
    (event) => event.type === "artifact.created" && event.payload.kind === AUTOPILOT_REPORT_KIND,
  );
  if (created?.type !== "artifact.created") throw new Error("no report");
  return AutopilotReportSchema.parse(created.payload.content);
}

function cookieOf(session: GuestSession): string {
  return `delegate_session=${signSession(session, secret)}`;
}

describe("Autopilot parent/child progression", () => {
  it("carries a goal through brief → X-ray → audit → build, chaining structured outputs", async () => {
    const h = await harness();
    const runId = await startAutopilot(h, { goal: "Cut support load", url: "acme.example" });
    await drain(h);
    const { events, state } = await parentState(h, runId);
    expect(state.status).toBe("completed");
    expect(state.children.map((child) => [child.nodeId, child.outcome?.status])).toEqual([
      ["brief", "completed"],
      ["company-xray", "completed"],
      ["audit", "completed"],
      ["build", "completed"],
    ]);
    const audit = state.children[2];
    const build = state.children[3];
    expect(build?.input).toMatchObject({
      url: acme.url,
      opportunityId: "opp-2",
      fromAuditRunId: audit?.childRunId,
    });
    expect(build?.from).toMatchObject({ fromRunId: audit?.childRunId, itemId: "opp-2" });
    expect(h.seen.map((args) => args.missionId)).toEqual([
      "custom-goal",
      "company-xray",
      "automation-audit",
      "build-agent",
    ]);
    const report = reportOf(events);
    expect(report.status).toBe("completed");
    expect(report.steps.every((step) => step.status === "completed")).toBe(true);
    expect(report.steps[3]?.outcome?.metrics).toContainEqual({ label: "Self-test", value: "80%" });
    expect(report.needsHuman.some((line) => line.includes("gaps report"))).toBe(true);

    const child = await readAllEvents(app, h.session.userId, build?.childRunId ?? "");
    expect(foldRun(child).autopilot).toEqual({ parentRunId: runId, nodeId: "build" });
    const record = await getRunRecord(app, h.session.userId, build?.childRunId ?? "");
    expect(record?.mission).toBe("build-agent");
  });

  it("resumes across lost invocations: the parent sweeps its children and relaunches a missing one", async () => {
    const h = await harness();
    const runId = await startAutopilot(h, { goal: "Cut support load", url: "acme.example" });
    h.tasks.length = 0;
    const briefId = crypto.randomUUID();
    await appendEvent(
      app,
      { runId, workspaceId: h.session.workspaceId, userId: h.session.userId },
      {
        type: "child.started",
        payload: {
          childRunId: briefId,
          nodeId: "brief",
          missionId: "custom-goal",
          label: "Goal brief",
          input: { goal: "Cut support load", url: acme.url },
          approvals: { plan: "human", sideEffects: "none" },
        },
      },
    );
    const parent = await getRunRecord(app, h.session.userId, runId);
    if (parent === null) throw new Error("no parent");
    await reviveOrSweep(app, h.session.userId, parent, h.deps);
    expect((await getRunRecord(app, h.session.userId, briefId))?.mission).toBe("custom-goal");
    expect(h.tasks).toHaveLength(1);

    h.tasks.length = 0;
    const later = { ...h.deps, now: () => new Date(Date.now() + 60_000) };
    const again = await getRunRecord(app, h.session.userId, runId);
    if (again === null) throw new Error("no parent");
    await reviveOrSweep(app, h.session.userId, again, later);
    expect(h.tasks).toHaveLength(1);
    const resumed = { ...h, deps: later };
    await drain(resumed);
    const { state } = await parentState(h, runId);
    expect(state.status).toBe("completed");
    expect(state.children).toHaveLength(4);
    const briefLog = await readAllEvents(app, h.session.userId, briefId);
    expect(
      briefLog.some(
        (event) => event.type === "policy.decided" && event.payload.policyId === "durable-resume",
      ),
    ).toBe(true);
  });

  it("stops on the first failure with a clear summary", async () => {
    const h = await harness({ fail: "company-xray" });
    const runId = await startAutopilot(h, { goal: "Cut support load", url: "acme.example" });
    await drain(h);
    const { events, state } = await parentState(h, runId);
    expect(state.status).toBe("failed");
    expect(state.error?.code).toBe("autopilot_child_failed");
    expect(state.error?.message).toContain("refused every fetch");
    expect(state.children).toHaveLength(2);
    const report = reportOf(events);
    expect(report.steps.map((step) => step.status)).toEqual([
      "completed",
      "failed",
      "not_started",
      "not_started",
    ]);
  });

  it("counts child runs against the guest quota and stops cleanly when it runs out", async () => {
    const h = await harness(
      {},
      { guestLimiter: createRateLimiter({ limit: 2, windowMs: 3_600_000 }) },
    );
    const runId = await startAutopilot(h, { goal: "Cut support load", url: "acme.example" });
    await drain(h);
    const { events, state } = await parentState(h, runId);
    expect(state.children).toHaveLength(2);
    expect(state.status).toBe("completed");
    expect(reportOf(events).stop?.reason).toBe("quota");
  });

  it("stops at the token cap before starting another child", async () => {
    const h = await harness({ tokensPerChild: 700_000 });
    const runId = await startAutopilot(h, { goal: "Cut support load", url: "acme.example" });
    await drain(h);
    const { events, state } = await parentState(h, runId);
    expect(state.children).toHaveLength(2);
    expect(reportOf(events).stop?.reason).toBe("token_cap");
  });
});

describe("Autopilot approvals and side effects", () => {
  it("gives a demo visitor a patch, never a pull request, and plans that wait for a human", async () => {
    const h = await harness({ track: "repo" });
    const runId = await startAutopilot(h, {
      goal: "Fix the flaky tests in github.com/acme/widget",
    });
    await drain(h);
    const { events, state } = await parentState(h, runId);
    expect(state.children.map((child) => child.missionId)).toEqual([
      "custom-goal",
      "repo-xray",
      "ship-a-pr",
    ]);
    const ship = state.children[2];
    expect(ship?.approvals).toEqual({ plan: "auto", sideEffects: "patch_only" });
    expect(ship?.input).toMatchObject({ repoUrl: REPO, improvement: { id: "imp-small" } });
    const shipArgs = h.seen.find((args) => args.missionId === "ship-a-pr");
    expect(shipArgs?.findInstallation).toBeUndefined();
    expect(state.children[0]?.approvals.plan).toBe("human");
    expect(h.seen[0]?.planApprover).toEqual({ type: "guest", id: h.session.userId });
    const report = reportOf(events);
    expect(report.tier).toBe("guest");
    expect(report.needsHuman.some((line) => line.startsWith("Apply the patch"))).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "policy.decided" &&
          event.payload.policyId === "autopilot" &&
          event.payload.reason.includes("patch only"),
      ),
    ).toBe(true);
  });

  it("lets a connected workspace reach a pull request that still asks, and follows auto-approve", async () => {
    const h = await harness({ track: "repo" });
    await storeInstallation(app, h.session, {
      installationId: 4242,
      accountLogin: "acme",
      accountType: "Organization",
      repositorySelection: "all",
      repositories: [],
      repositoriesVerified: false,
      githubUserId: 1,
      githubLogin: "octo",
    });
    await updateAutomation(app, h.session, { autoApprovePlans: true });
    const runId = await startAutopilot(h, {
      goal: "Fix the flaky tests in github.com/acme/widget",
    });
    await drain(h);
    const { events, state } = await parentState(h, runId);
    expect(state.children[0]?.approvals).toEqual({ plan: "auto", sideEffects: "ask" });
    expect(state.children[2]?.approvals).toEqual({ plan: "auto", sideEffects: "ask" });
    expect(h.seen[0]?.planApprover).toEqual({ type: "system", id: "auto-approve" });
    expect(h.seen.find((args) => args.missionId === "ship-a-pr")?.findInstallation).toBeDefined();
    const report = reportOf(events);
    expect(report.tier).toBe("connected");
    expect(report.steps[2]?.outcome?.links).toContainEqual({
      label: "PR #7",
      href: "https://github.com/acme/widget/pull/7",
    });
  });

  it("does not launch Ship-a-PR where the deployment cannot run it", async () => {
    const h = await harness({ track: "repo" }, { shipEnabled: false });
    const runId = await startAutopilot(h, {
      goal: "Fix the flaky tests in github.com/acme/widget",
    });
    await drain(h);
    const { events, state } = await parentState(h, runId);
    expect(state.children).toHaveLength(2);
    expect(reportOf(events).stop?.reason).toBe("unavailable");
  });

  it("refuses nested autopilots", () => {
    expect(
      CreateRunRequestSchema.safeParse({
        missionId: "autopilot",
        input: { goal: "Do it all" },
        parentRunId: crypto.randomUUID(),
      }).success,
    ).toBe(false);
  });
});

describe("Autopilot API surfaces", () => {
  it("serves the mission graph with live child status and cancels the open child with the parent", async () => {
    const h = await harness();
    const runId = await startAutopilot(h, { goal: "Cut support load", url: "acme.example" });
    const advance = h.tasks.shift();
    await advance?.();
    const cookie = cookieOf(h.session);
    const response = await handleRunChildren(
      new Request(`${ORIGIN}/api/runs/${runId}/children`, { headers: { cookie } }),
      runId,
      h.deps,
    );
    const body = (await response.json()) as { children: AutopilotGraphNode[] };
    expect(body.children.map((node) => [node.nodeId, node.status])).toEqual([
      ["brief", "planning"],
    ]);
    const brief = body.children[0]?.childRunId ?? "";

    const cancelled = await handleCancelRun(
      new Request(`${ORIGIN}/api/runs/${runId}/cancel`, {
        method: "POST",
        headers: { cookie, origin: ORIGIN, host: "localhost:3000" },
      }),
      runId,
      h.deps,
    );
    expect(cancelled.status).toBe(200);
    const child = await getRunRecord(app, h.session.userId, brief);
    expect(child?.status).toBe("failed");
    expect(child?.lastEventType).toBe("run.failed");
  });
});

describe("Autopilot cancel/launch interleaving", () => {
  async function startedChild(h: Harness, runId: string): Promise<ChildStartedPayload> {
    h.tasks.length = 0;
    const started: ChildStartedPayload = {
      childRunId: crypto.randomUUID(),
      nodeId: "brief",
      missionId: "custom-goal",
      label: "Goal brief",
      input: { goal: "Cut support load", url: acme.url },
      approvals: { plan: "human", sideEffects: "none" },
    };
    await appendEvent(app, parentCtx(h, runId), { type: "child.started", payload: started });
    return started;
  }

  function parentCtx(h: Harness, runId: string) {
    return { runId, workspaceId: h.session.workspaceId, userId: h.session.userId };
  }

  it("fails and never schedules a child whose parent went terminal before its row was created", async () => {
    const h = await harness();
    const runId = await startAutopilot(h, { goal: "Cut support load", url: "acme.example" });
    const started = await startedChild(h, runId);
    await appendEvent(app, parentCtx(h, runId), {
      type: "run.failed",
      payload: { error: { code: "cancelled", message: "cancelled by user" } },
    });

    await launchChild(app, parentCtx(h, runId), started, h.deps);

    expect(h.tasks).toHaveLength(0);
    const child = foldRun(await readAllEvents(app, h.session.userId, started.childRunId));
    expect(child.status).toBe("failed");
    expect(child.error?.code).toBe("cancelled_by_parent");
    await drain(h);
    expect(h.seen).toHaveLength(0);
  });

  it("records a started child with no row as cancelled so the in-flight launch refuses", async () => {
    const h = await harness();
    const runId = await startAutopilot(h, { goal: "Cut support load", url: "acme.example" });
    const started = await startedChild(h, runId);

    const cancelled = await handleCancelRun(
      new Request(`${ORIGIN}/api/runs/${runId}/cancel`, {
        method: "POST",
        headers: { cookie: cookieOf(h.session), origin: ORIGIN, host: "localhost:3000" },
      }),
      runId,
      h.deps,
    );
    expect(cancelled.status).toBe(200);
    const recorded = await getRunRecord(app, h.session.userId, started.childRunId);
    expect(recorded?.status).toBe("failed");
    expect(recorded?.mission).toBe("custom-goal");

    await launchChild(app, parentCtx(h, runId), started, h.deps);

    expect(h.tasks).toHaveLength(0);
    await drain(h);
    expect(h.seen).toHaveLength(0);
    const child = foldRun(await readAllEvents(app, h.session.userId, started.childRunId));
    expect(child.status).toBe("failed");
    expect(child.error?.code).toBe("cancelled_by_parent");
    expect(child.autopilot).toEqual({ parentRunId: runId, nodeId: "brief" });
  });
});
