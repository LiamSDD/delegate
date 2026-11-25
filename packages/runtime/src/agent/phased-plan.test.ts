import { CAPABILITIES } from "@delegate/policy";
import { describe, expect, it } from "vitest";

import {
  foldRun,
  parseRunEvent,
  type PlanPhase,
  type PlanStep,
  type RunEventDraft,
} from "../events";
import { loadPrompt } from "../server";
import { scriptedProvider, testRun, textTurn } from "../testing/fakes";
import { type AwaitPlanApproval } from "../plan-approval";
import {
  AUTO_APPROVAL_REASON,
  AUTO_APPROVER,
  runPlannedMission,
  type PlannedMission,
} from "./mission-runner";
import { missionClock } from "./pacing";
import { orchestrate, type RevisionGate } from "./orchestrator";
import {
  adoptPhases,
  checkPlanSteps,
  proposePlan,
  revisionApproval,
  validatePhases,
  type PlannerMission,
} from "./planner";
import { type StepExecutor, type SubAgentResult } from "./subagent";

const plannerPrompt = loadPrompt("planner.v3.md");

const ok = (summary: string, extra: Partial<SubAgentResult> = {}): SubAgentResult => ({
  summary,
  findings: [],
  sources: [],
  confidence: 0.9,
  artifacts: [],
  ...extra,
});

const exec = (id: string, extra: Partial<StepExecutor> = {}): StepExecutor => ({
  id,
  role: "researcher",
  modelRole: "worker",
  capabilities: [CAPABILITIES.webFetch],
  description: id,
  run: () => Promise.resolve(ok(id)),
  ...extra,
});

const step = (id: string, phase: string | undefined, extra: Partial<PlanStep> = {}): PlanStep => ({
  id,
  role: "researcher",
  objective: `Do ${id}`,
  inputs: [],
  capabilities: [CAPABILITIES.webFetch],
  acceptance: ["done"],
  budgetShare: 0.1,
  ...(phase === undefined ? {} : { phase }),
  ...extra,
});

const PHASES: PlanPhase[] = [
  { id: "research", objective: "Gather evidence", budgetShare: 0.4, dependsOn: [] },
  { id: "draft", objective: "Write it", budgetShare: 0.4, dependsOn: ["research"] },
  { id: "verify", objective: "Check it", budgetShare: 0.2, dependsOn: ["draft"] },
];

const PLAN: PlanStep[] = [
  step("site", "research"),
  step("topic", "research"),
  step("write", "draft", {
    role: "editor",
    inputs: ["site", "topic"],
    capabilities: [CAPABILITIES.artifactWrite],
    budgetShare: 0.3,
  }),
  step("check", "verify", {
    role: "critic",
    inputs: ["write"],
    capabilities: [CAPABILITIES.artifactWrite],
  }),
];

const EXECUTORS: StepExecutor[] = [
  exec("site"),
  exec("topic"),
  exec("extra", { repeatable: true }),
  exec("write", { role: "editor", capabilities: [CAPABILITIES.artifactWrite], required: true }),
  exec("check", { role: "critic", capabilities: [CAPABILITIES.artifactWrite], required: true }),
  exec("notify", {
    capabilities: [CAPABILITIES.connectorWrite],
    description: "Post the brief to the workspace tracker",
  }),
];

const MISSION: PlannerMission = {
  missionId: "custom-goal",
  title: "Phased test",
  objective: "Test",
  input: {},
  planningHints: "none",
  executors: EXECUTORS,
  allowedCapabilities: [
    CAPABILITIES.webFetch,
    CAPABILITIES.artifactWrite,
    CAPABILITIES.connectorWrite,
  ],
  defaultPhases: PHASES,
};

describe("two-level plan validation", () => {
  it("accepts a phased plan and the same steps without phases", () => {
    expect(validatePhases(PLAN, PHASES)).toEqual([]);
    expect(checkPlanSteps(PLAN, MISSION, PHASES).ok).toBe(true);
    const flat = PLAN.map(({ phase: _phase, ...rest }) => rest);
    const { defaultPhases: _phases, ...flatMission } = MISSION;
    expect(checkPlanSteps(flat, flatMission).ok).toBe(true);
  });

  it("rejects forward dependencies, unknown or empty phases, bad dependsOn and budget overruns", () => {
    const issues = validatePhases(
      [
        step("site", "research", { inputs: ["write"] }),
        step("write", "draft", { budgetShare: 0.5 }),
        step("lost", "nowhere"),
        step("loose", undefined),
      ],
      [
        { id: "research", objective: "r", budgetShare: 0.4, dependsOn: ["draft"] },
        { id: "draft", objective: "d", budgetShare: 0.4, dependsOn: [] },
        { id: "verify", objective: "v", budgetShare: 0.3, dependsOn: [] },
      ],
    ).join("\n");
    expect(issues).toMatch(/research depends on draft, which is not an earlier phase/);
    expect(issues).toMatch(/site \(phase research\) uses write from a later phase/);
    expect(issues).toMatch(/Steps in phase draft use budgetShare 0.500/);
    expect(issues).toMatch(/lost names unknown phase nowhere/);
    expect(issues).toMatch(/loose has no phase/);
    expect(issues).toMatch(/Phase verify has no steps/);
    expect(issues).toMatch(/sum to 1.100/);
    expect(validatePhases([step("a", "x")], undefined)).toEqual([
      "Steps name phases, but the plan defines no phases",
    ]);
  });

  it("adopts the mission's default phases when the planner names known phases but omits them", () => {
    const adopted = adoptPhases(PLAN, undefined, PHASES);
    expect(adopted?.map((phase) => [phase.id, phase.budgetShare])).toEqual([
      ["research", 0.2],
      ["draft", 0.3],
      ["verify", 0.1],
    ]);
    expect(adoptPhases([step("a", "other")], undefined, PHASES)).toBeUndefined();
  });

  it("lets the planner propose phases, validated with one repair", async () => {
    const provider = scriptedProvider("fake", [
      textTurn(JSON.stringify({ steps: PLAN, phases: [{ ...PHASES[0], dependsOn: ["verify"] }] })),
      textTurn(JSON.stringify({ steps: PLAN, phases: PHASES, rationale: "Three phases." })),
    ]);
    const proposed = await proposePlan(testRun({ provider }).ctx, {
      mission: MISSION,
      defaultPlan: PLAN,
      prompt: plannerPrompt,
      usePlanner: true,
    });
    expect(proposed.source).toBe("planner");
    expect(proposed.phases?.map((phase) => phase.id)).toEqual(["research", "draft", "verify"]);
    expect(provider.requests).toHaveLength(2);
  });
});

describe("revision approval rules", () => {
  it("needs approval only when a revision adds capabilities or side effects", () => {
    const within = [...PLAN.slice(0, 2), step("extra_2", "research"), ...PLAN.slice(2)];
    expect(revisionApproval(PLAN, within)).toEqual({
      required: false,
      addedCapabilities: [],
      sideEffectSteps: [],
    });
    const notify = step("notify", "verify", {
      inputs: ["check"],
      capabilities: [CAPABILITIES.connectorWrite],
    });
    expect(revisionApproval(PLAN, [...PLAN, notify])).toEqual({
      required: true,
      addedCapabilities: [CAPABILITIES.connectorWrite],
      sideEffectSteps: ["notify"],
    });
    const approvedWithNotify = [...PLAN, notify];
    const moved = [...PLAN, { ...notify, id: "notify_2" }];
    expect(revisionApproval(approvedWithNotify, moved)).toMatchObject({
      required: true,
      addedCapabilities: [],
      sideEffectSteps: ["notify_2"],
    });
  });
});

function folded(events: readonly RunEventDraft[]) {
  return foldRun(
    [
      {
        runId: "run_1",
        type: "run.created",
        payload: {
          workspaceId: "ws_1",
          missionId: "custom-goal",
          input: {},
          actor: { type: "system", id: "test" },
          budget: { maxTokens: 1000, maxMicroUsd: 0 },
        },
      } satisfies RunEventDraft,
      ...events,
    ].map((event, index) =>
      parseRunEvent({ ...event, seq: index + 1, at: "2026-11-24T10:00:00.000Z" }),
    ),
  );
}

describe("phased orchestration", () => {
  it("runs phases in order and steps within a phase in parallel", async () => {
    const order: string[] = [];
    let running = 0;
    let peak = 0;
    const timed = (id: string): StepExecutor =>
      exec(id, {
        run: async () => {
          running += 1;
          peak = Math.max(peak, running);
          order.push(`start:${id}`);
          await new Promise((resolve) => setTimeout(resolve, 5));
          order.push(`end:${id}`);
          running -= 1;
          return ok(id);
        },
      });
    const plan = [step("site", "research"), step("topic", "research"), step("other", "draft")];
    const { ctx } = testRun({ provider: scriptedProvider("fake", []) });
    const outcome = await orchestrate(ctx, {
      plan,
      phases: PHASES.slice(0, 2),
      version: 1,
      executors: [timed("site"), timed("topic"), timed("other")],
    });
    expect([...outcome.statuses.values()].every((status) => status === "succeeded")).toBe(true);
    expect(peak).toBe(2);
    expect(order.indexOf("start:other")).toBeGreaterThan(order.indexOf("end:site"));
    expect(order.indexOf("start:other")).toBeGreaterThan(order.indexOf("end:topic"));
  });

  it("replans at a phase boundary when a finished phase reports broken assumptions", async () => {
    const triggers: string[] = [];
    const { ctx, events } = testRun({ provider: scriptedProvider("fake", []) });
    const executors = EXECUTORS.map((executor) =>
      executor.id === "site"
        ? exec("site", {
            run: () =>
              Promise.resolve(ok("site", { needsReplan: { reason: "Only 1 page could be read" } })),
          })
        : executor,
    );
    const outcome = await orchestrate(ctx, {
      plan: PLAN,
      phases: PHASES,
      version: 1,
      executors,
      replan: (state) => {
        triggers.push(state.trigger.reason);
        const extra = step("extra_2", "draft", { inputs: ["site"], budgetShare: 0.05 });
        return Promise.resolve({
          steps: [...state.plan.slice(0, 3), extra, ...state.plan.slice(3)].map((entry) =>
            entry.id === "check" ? { ...entry, inputs: ["write", "extra_2"] } : entry,
          ),
          reason: "Add another research pass",
        });
      },
    });
    expect(triggers).toEqual([
      "Phase research finished, but its assumptions need review: Only 1 page could be read",
    ]);
    expect(outcome.version).toBe(2);
    expect(outcome.statuses.get("extra_2")).toBe("succeeded");
    const revised = events.find((event) => event.type === "plan.revised");
    expect(revised).toMatchObject({ payload: { version: 2, phases: PHASES } });
  });

  it("asks for approval again when a revision adds a side-effecting step, and reverts if rejected", async () => {
    const asked: number[] = [];
    const restored: number[] = [];
    const gate: RevisionGate = {
      requiresApproval: (revision) => revisionApproval(PLAN, revision.steps).required,
      approve: (revision) => {
        asked.push(revision.version);
        return Promise.resolve(false);
      },
      restored: (version) => {
        restored.push(version);
        return Promise.resolve();
      },
    };
    const notifyRuns: string[] = [];
    const executors = EXECUTORS.map((executor) =>
      executor.id === "site"
        ? exec("site", {
            run: () => Promise.resolve(ok("site", { needsReplan: { reason: "thin" } })),
          })
        : executor.id === "notify"
          ? {
              ...executor,
              run: () => {
                notifyRuns.push("notify");
                return Promise.resolve(ok("notify"));
              },
            }
          : executor,
    );
    const { ctx, events } = testRun({ provider: scriptedProvider("fake", []) });
    const outcome = await orchestrate(ctx, {
      plan: PLAN,
      phases: PHASES,
      version: 1,
      executors,
      approveRevision: gate,
      replan: (state) =>
        Promise.resolve({
          steps: [
            ...state.plan,
            step("notify", "verify", {
              inputs: ["check"],
              capabilities: [CAPABILITIES.connectorWrite],
              budgetShare: 0.05,
            }),
          ],
          reason: "Post the brief",
        }),
    });
    expect(asked).toEqual([2]);
    expect(restored).toEqual([3]);
    expect(notifyRuns).toEqual([]);
    expect(outcome.plan.map((entry) => entry.id)).toEqual(PLAN.map((entry) => entry.id));
    const revisions = events.flatMap((event) => (event.type === "plan.revised" ? [event] : []));
    expect(revisions.map((event) => event.payload.requiresApproval)).toEqual([true, undefined]);
  });
});

describe("runPlannedMission approval semantics for revisions", () => {
  const mission = (replanSteps: (plan: readonly PlanStep[]) => PlanStep[]): PlannedMission => {
    const { ctx } = testRun({ provider: scriptedProvider("fake", []) });
    return {
      planner: {
        ...MISSION,
        executors: EXECUTORS.map((executor) =>
          executor.id === "site"
            ? exec("site", {
                run: () =>
                  Promise.resolve(ok("site", { confidence: 0.2, needsReplan: { reason: "thin" } })),
              })
            : executor,
        ),
      },
      defaultPlan: PLAN,
      clock: missionClock(ctx, 1_000_000),
      finish: () => Promise.resolve({ status: "completed", summary: `${replanSteps.length}` }),
    };
  };

  async function run(
    replanSteps: (plan: readonly PlanStep[]) => PlanStep[],
    awaitPlanApproval?: AwaitPlanApproval,
  ) {
    const provider = scriptedProvider("fake", (request) => {
      const user = request.messages.find((entry) => entry.role === "user");
      const text = user?.role === "user" ? user.content : "";
      if (text.includes("## Current plan"))
        return textTurn(JSON.stringify({ steps: replanSteps(PLAN), reason: "Revise" }));
      return textTurn(JSON.stringify({ steps: PLAN, phases: PHASES, rationale: "ok" }));
    });
    const { ctx, events } = testRun({ provider });
    const planned = mission(replanSteps);
    planned.clock = missionClock(ctx, 1_000_000);
    const status = await runPlannedMission(ctx, planned, {
      plannerPrompt,
      ...(awaitPlanApproval === undefined ? {} : { awaitPlanApproval }),
    });
    return { status, events, state: folded(events) };
  }

  it("does not ask again for a revision within the approved capabilities", async () => {
    const asked: number[] = [];
    const { status, events, state } = await run(
      (plan) => [
        ...plan.slice(0, 2),
        step("extra_2", "research", { budgetShare: 0.05 }),
        ...plan.slice(2),
      ],
      (proposal) => {
        asked.push(proposal.version);
        return Promise.resolve({ decision: "approved" });
      },
    );
    expect(status).toBe("completed");
    expect(asked).toEqual([1]);
    expect(events.filter((event) => event.type === "plan.approved")).toHaveLength(1);
    expect(state.plan).toMatchObject({ version: 2, approved: true });
  });

  it("asks again for a revision that adds a side effect and records the re-approval", async () => {
    const asked: unknown[] = [];
    const { status, events, state } = await run(
      (plan) => [
        ...plan,
        step("notify", "verify", {
          inputs: ["check"],
          capabilities: [CAPABILITIES.connectorWrite],
          budgetShare: 0.05,
        }),
      ],
      (proposal) => {
        asked.push(
          proposal.kind === "revision"
            ? [proposal.version, proposal.kind, proposal.required]
            : [proposal.version, proposal.kind],
        );
        return Promise.resolve({ decision: "approved" });
      },
    );
    expect(status).toBe("completed");
    expect(asked).toEqual([
      [1, "initial"],
      [2, "revision", true],
    ]);
    const approvals = events.flatMap((event) => (event.type === "plan.approved" ? [event] : []));
    expect(approvals.map((event) => event.payload.version)).toEqual([1, 2]);
    expect(approvals[1]).toMatchObject({
      payload: { reason: expect.stringMatching(/adds capabilities connector.write/) as unknown },
    });
    expect(state.plan).toMatchObject({ version: 2, approved: true });
    expect(state.steps.find((entry) => entry.id === "notify")?.status).toBe("succeeded");
  });

  it("auto-approves a widening revision with the no-reviewer reason when no waiter is attached", async () => {
    const { status, events } = await run((plan) => [
      ...plan,
      step("notify", "verify", {
        inputs: ["check"],
        capabilities: [CAPABILITIES.connectorWrite],
        budgetShare: 0.05,
      }),
    ]);
    expect(status).toBe("completed");
    const approvals = events.flatMap((event) => (event.type === "plan.approved" ? [event] : []));
    expect(approvals.map((event) => event.payload.version)).toEqual([1, 2]);
    expect(approvals[1]?.payload).toMatchObject({
      approvedBy: AUTO_APPROVER,
      reason: expect.stringContaining(AUTO_APPROVAL_REASON) as unknown,
    });
  });
});
