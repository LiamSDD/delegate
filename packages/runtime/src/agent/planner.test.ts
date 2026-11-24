import { CAPABILITIES } from "@delegate/policy";
import { describe, expect, it } from "vitest";

import { type PlanStep } from "../events";
import { loadPrompt } from "../server";
import { scriptedProvider, testRun, textTurn } from "../testing/fakes";
import {
  executorFor,
  proposePlan,
  restoreLockedSteps,
  revisePlan,
  validatePlan,
  type PlannerMission,
} from "./planner";
import { type StepExecutor } from "./subagent";

const prompt = loadPrompt("planner.v2.md");

const exec = (id: string, extra: Partial<StepExecutor> = {}): StepExecutor => ({
  id,
  role: "researcher",
  modelRole: "worker",
  capabilities: [CAPABILITIES.webFetch],
  description: id,
  run: () => Promise.reject(new Error("not run")),
  ...extra,
});

const mission: PlannerMission = {
  missionId: "company-xray",
  title: "Test",
  objective: "Test mission",
  input: { url: "https://acme.example/" },
  planningHints: "none",
  allowedCapabilities: [CAPABILITIES.webFetch, CAPABILITIES.artifactWrite],
  executors: [
    exec("research"),
    exec("fill_gaps", { repeatable: true }),
    exec("write", {
      role: "editor",
      capabilities: [CAPABILITIES.artifactWrite],
      needs: ["research"],
      required: true,
    }),
  ],
};

const step = (id: string, extra: Partial<PlanStep> = {}): PlanStep => ({
  id,
  role: "researcher",
  objective: `Do ${id}`,
  inputs: [],
  capabilities: [CAPABILITIES.webFetch],
  acceptance: ["done"],
  budgetShare: 0.2,
  ...extra,
});

const good = [
  step("research"),
  step("write", {
    role: "editor",
    inputs: ["research"],
    capabilities: [CAPABILITIES.artifactWrite],
  }),
];

describe("validatePlan", () => {
  it("accepts a plan that composes library steps", () => {
    expect(validatePlan(good, mission)).toEqual([]);
    expect(executorFor(mission.executors, "fill_gaps_2")?.id).toBe("fill_gaps");
    expect(executorFor(mission.executors, "research_2")).toBeUndefined();
  });

  it("rejects unknown steps, escalated capabilities, wrong roles, cycles, missing needs and missing required steps", () => {
    const issues = validatePlan(
      [
        step("research", { capabilities: [CAPABILITIES.messageSend] }),
        step("shell", {}),
        step("fill_gaps", { role: "analyst", inputs: ["fill_gaps_2"] }),
        step("fill_gaps_2", { inputs: ["fill_gaps"] }),
      ],
      mission,
    );
    expect(issues.join("\n")).toMatch(/message\.send, which this mission does not allow/);
    expect(issues.join("\n")).toMatch(/shell does not match any step/);
    expect(issues.join("\n")).toMatch(/fill_gaps must use role researcher/);
    expect(issues.join("\n")).toMatch(/cycle/);
    expect(issues.join("\n")).toMatch(/must include step write/);
    expect(
      validatePlan(
        [
          step("research"),
          step("write", { role: "editor", capabilities: [CAPABILITIES.artifactWrite] }),
        ],
        mission,
      ).join(),
    ).toMatch(/write needs research/);
  });
});

describe("proposePlan", () => {
  it("uses the planner's plan after one repair", async () => {
    const provider = scriptedProvider("fake", [
      textTurn(JSON.stringify({ steps: [step("research"), step("hack")] })),
      textTurn(JSON.stringify({ steps: good, rationale: "Research, then write." })),
    ]);
    const { ctx } = testRun({ provider });
    const plan = await proposePlan(ctx, { mission, defaultPlan: [], prompt, usePlanner: true });
    expect(plan).toMatchObject({ source: "planner", rationale: "Research, then write." });
    expect(plan.steps.map((entry) => entry.id)).toEqual(["research", "write"]);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]?.tools).toBeUndefined();
  });

  it("falls back to the mission's default plan when the planner fails twice", async () => {
    const provider = scriptedProvider("fake", [textTurn("{}"), textTurn("still wrong")]);
    const { ctx } = testRun({ provider });
    const plan = await proposePlan(ctx, { mission, defaultPlan: good, prompt, usePlanner: true });
    expect(plan.source).toBe("default");
    expect(plan.steps).toEqual(good);
    expect(plan.fallbackReason).toMatch(/twice/);
  });

  it("scales budget shares that sum to more than one", async () => {
    const provider = scriptedProvider("fake", [
      textTurn(JSON.stringify({ steps: good.map((entry) => ({ ...entry, budgetShare: 0.9 })) })),
    ]);
    const { ctx } = testRun({ provider });
    const plan = await proposePlan(ctx, { mission, defaultPlan: [], prompt, usePlanner: true });
    expect(plan.steps.reduce((sum, entry) => sum + entry.budgetShare, 0)).toBeLessThanOrEqual(1);
  });
});

describe("revisePlan", () => {
  it("keeps locked steps unchanged even if the planner edits them", async () => {
    const tampered = [
      step("research", { objective: "Rewritten history" }),
      step("fill_gaps_2", { inputs: ["research"] }),
      step("write", {
        role: "editor",
        inputs: ["research", "fill_gaps_2"],
        capabilities: [CAPABILITIES.artifactWrite],
      }),
    ];
    const provider = scriptedProvider("fake", [
      textTurn(JSON.stringify({ steps: tampered, reason: "Thin evidence; one more pass." })),
    ]);
    const { ctx } = testRun({ provider });
    const statuses = new Map([
      ["research", "succeeded" as const],
      ["write", "pending" as const],
    ]);
    const revised = await revisePlan(ctx, {
      mission,
      prompt,
      state: {
        plan: good,
        version: 1,
        statuses,
        results: new Map(),
        trigger: { stepId: "research", reason: "Low confidence" },
      },
    });
    expect(revised?.steps.map((entry) => entry.id)).toEqual(["research", "fill_gaps_2", "write"]);
    expect(revised?.steps[0]?.objective).toBe("Do research");
    expect(restoreLockedSteps([], { plan: good, statuses })).toEqual([good[0]]);
  });
});
