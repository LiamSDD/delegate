import { readFileSync } from "node:fs";

import { CAPABILITIES } from "@delegate/policy";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { BudgetExceededError } from "../budget";
import { analyseForResume } from "../durable/checkpoints";
import { planFork } from "../durable/fork";
import {
  foldRun,
  parseRunEvent,
  type PlanStep,
  type PlanTeam,
  type RunEvent,
  type RunEventDraft,
} from "../events";
import { parsePromptFile } from "../prompts";
import { scriptedProvider, testRun, textTurn } from "../testing/fakes";
import { defineTool, executeToolCall } from "../tools/registry";
import { callModel } from "./model-call";
import { orchestrate } from "./orchestrator";
import { checkPlanSteps, proposePlan, validatePlan, type PlannerMission } from "./planner";
import { FatalStepError, type StepExecutor, type SubAgentResult } from "./subagent";
import { TEAM_LIMITS, mergeFindings, type TeamMember, type TeamOutcome } from "./team";

const TEAM: PlanTeam = {
  size: 3,
  from: "resolve",
  reducer: "merge_findings",
  memberTokens: 20_000,
  memberMs: 60_000,
};

const resolveStep: PlanStep = {
  id: "resolve",
  role: "researcher",
  objective: "Resolve the target",
  inputs: [],
  capabilities: [CAPABILITIES.webFetch],
  acceptance: ["done"],
  budgetShare: 0.1,
};

const topicStep = (team: PlanTeam | null = TEAM, id = "topic"): PlanStep => ({
  id,
  role: "researcher",
  objective: "Research each topic",
  inputs: ["resolve"],
  capabilities: [CAPABILITIES.webFetch],
  acceptance: ["Every fact carries a quote"],
  budgetShare: 0.3,
  ...(team === null ? {} : { team }),
});

const finding = (text: string, source: string, quote = text) => ({
  text,
  citations: [source],
  quote,
  topic: "offering",
  trust: "untrusted" as const,
});

const source = (sourceId: string) => ({
  sourceId,
  url: `https://example.com/${sourceId}`,
  title: sourceId,
  fetchedAt: "2026-11-25T10:00:00.000Z",
  kind: "wikipedia" as const,
});

const memberResult = (id: string, confidence = 0.8): SubAgentResult => ({
  summary: `member ${id}`,
  findings: [finding(`fact from ${id}`, id === "a" ? "S1" : id === "b" ? "S2" : "S3")],
  sources: [source(id === "a" ? "S1" : id === "b" ? "S2" : "S3")],
  confidence,
  artifacts: [],
});

function executors(
  member: (member: TeamMember) => Promise<SubAgentResult>,
  seen: { outcome?: TeamOutcome; hadTeam?: boolean } = {},
  assignments = ["a", "b", "c"],
): StepExecutor[] {
  return [
    {
      id: "resolve",
      role: "researcher",
      modelRole: "fast",
      capabilities: [CAPABILITIES.webFetch],
      description: "resolve",
      run: () =>
        Promise.resolve({
          summary: "resolved",
          findings: [],
          sources: [],
          confidence: 1,
          artifacts: [],
        }),
    },
    {
      id: "topic",
      role: "researcher",
      modelRole: "fast",
      capabilities: [CAPABILITIES.webFetch],
      description: "topic",
      repeatable: true,
      team: { maxMembers: 3, reducers: ["merge_findings"] },
      run: async (task) => {
        seen.hadTeam = task.team !== undefined;
        if (task.team === undefined) return memberResult("solo");
        const outcome = await task.team.run({
          assignments: assignments.map((id) => ({ id, objective: `Research topic ${id}` })),
          role: "researcher",
          modelRole: "fast",
          member,
        });
        seen.outcome = outcome;
        return outcome.result;
      },
    },
  ];
}

const mission = (library: readonly StepExecutor[]): PlannerMission => ({
  missionId: "custom-goal",
  title: "Goal",
  objective: "o",
  input: {},
  planningHints: "",
  executors: library,
  allowedCapabilities: [CAPABILITIES.webFetch],
});

function logOf(events: readonly RunEventDraft[], plan: readonly PlanStep[]): RunEvent[] {
  const head: RunEventDraft[] = [
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
    },
    { runId: "run_1", type: "plan.proposed", payload: { version: 1, steps: [...plan] } },
    {
      runId: "run_1",
      type: "plan.approved",
      payload: { version: 1, approvedBy: { type: "system", id: "test" } },
    },
  ];
  return [...head, ...events].map((event, index) =>
    parseRunEvent({ ...event, seq: index + 1, at: "2026-11-25T10:00:00.000Z" }),
  );
}

describe("validateTeams through validatePlan and checkPlanSteps", () => {
  const library = executors(() => Promise.resolve(memberResult("a")));
  const issuesFor = (team: PlanTeam, extra: PlanStep[] = []) =>
    validatePlan([resolveStep, topicStep(team), ...extra], mission(library));

  it("accepts a team within every cap, and a plan without teams is unchanged", () => {
    expect(issuesFor(TEAM)).toEqual([]);
    expect(validatePlan([resolveStep, topicStep(null)], mission(library))).toEqual([]);
    expect(checkPlanSteps([resolveStep, topicStep()], mission(library))).toMatchObject({
      ok: true,
    });
  });

  it.each([
    ["a team of one", { ...TEAM, size: 1 }, /allows 2 to 3 members/],
    ["more members than the step allows", { ...TEAM, size: 4 }, /allows 2 to 3 members/],
    ["a member token budget that is too small", { ...TEAM, memberTokens: 500 }, /tokens/],
    ["a member token budget that is too large", { ...TEAM, memberTokens: 90_000 }, /tokens/],
    ["a member deadline that is too short", { ...TEAM, memberMs: 1_000 }, /ms/],
    ["a member deadline that is too long", { ...TEAM, memberMs: 600_000 }, /ms/],
    ["a source step that is not an input", { ...TEAM, from: "topic" }, /not among its/],
  ])("rejects %s", (_label, team, message) => {
    expect(issuesFor(team).join("\n")).toMatch(message);
    expect(checkPlanSteps([resolveStep, topicStep(team)], mission(library)).ok).toBe(false);
  });

  it("rejects a team on a step whose library entry does not allow one", () => {
    const issues = validatePlan(
      [{ ...resolveStep, team: { ...TEAM, from: "resolve" } }],
      mission(library),
    );
    expect(issues.join("\n")).toMatch(/cannot run as a team/);
  });

  it("caps the members of all teams in a plan", () => {
    const wide = executors(() => Promise.resolve(memberResult("a"))).map((entry) =>
      entry.id === "topic"
        ? { ...entry, team: { maxMembers: 6, reducers: ["merge_findings" as const] } }
        : entry,
    );
    const six = { ...TEAM, size: 6 };
    const plan = [
      resolveStep,
      { ...topicStep(six), budgetShare: 0.2 },
      { ...topicStep(six, "topic_2"), budgetShare: 0.2 },
      { ...topicStep({ ...TEAM, size: 2 }, "topic_3"), budgetShare: 0.2 },
    ];
    expect(validatePlan(plan, mission(wide)).join("\n")).toMatch(
      new RegExp(`14 members in total; at most ${TEAM_LIMITS.maxMembersPerRun}`),
    );
  });

  it("refuses a malformed declaration in the event schema", () => {
    const parsed = checkPlanSteps(
      [resolveStep, { ...topicStep(), team: { ...TEAM, reducer: "vote" } }],
      mission(library),
    );
    expect(parsed.ok).toBe(false);
  });
});

describe("mergeFindings", () => {
  it("keeps member order, drops duplicates and averages confidence", () => {
    const merged = mergeFindings([
      {
        summary: "a",
        findings: [finding("one", "S1"), finding("two", "S1")],
        sources: [source("S1")],
        confidence: 0.9,
        artifacts: ["art_1"],
      },
      {
        summary: "b",
        findings: [finding("one again", "S1", "one"), finding("three", "S2")],
        sources: [source("S1"), source("S2")],
        confidence: 0.5,
        artifacts: ["art_1", "art_2"],
      },
    ]);
    expect(merged.findings.map((entry) => entry.text)).toEqual(["one", "two", "three"]);
    expect(merged.sources.map((entry) => entry.sourceId)).toEqual(["S1", "S2"]);
    expect(merged.artifacts).toEqual(["art_1", "art_2"]);
    expect(merged.confidence).toBeCloseTo(0.7);
  });

  it("reports zero confidence when no member finished", () => {
    expect(mergeFindings([])).toMatchObject({ findings: [], confidence: 0 });
  });
});

describe("a team step in the orchestrator", () => {
  const plan = [resolveStep, topicStep()];

  it("runs members in parallel and records them with the existing sub-agent events", async () => {
    const { ctx, events } = testRun({ provider: scriptedProvider("fake", []) });
    let active = 0;
    let peak = 0;
    const seen: { outcome?: TeamOutcome } = {};
    const outcome = await orchestrate(ctx, {
      plan,
      version: 1,
      executors: executors(async (member) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return memberResult(member.assignment.id);
      }, seen),
    });
    expect(peak).toBe(3);
    expect(outcome.statuses.get("topic")).toBe("succeeded");
    expect(outcome.results.get("topic")?.findings.map((entry) => entry.text)).toEqual([
      "fact from a",
      "fact from b",
      "fact from c",
    ]);
    expect(seen.outcome?.members.map((member) => member.status)).toEqual([
      "finished",
      "finished",
      "finished",
    ]);
    const onTopic = events.filter((event) => "stepId" in event && event.stepId === "topic");
    expect(onTopic.filter((event) => event.type === "agent.spawned")).toHaveLength(4);
    expect(
      onTopic.flatMap((event) => (event.type === "agent.message" ? [event.payload.text] : [])),
    ).toEqual(
      expect.arrayContaining([
        "Team member 1 of 3: Research topic a",
        "Team member 2 of 3: Research topic b",
        "Team member 3 of 3: Research topic c",
      ]),
    );
    expect(new Set(events.map((event) => event.type))).toEqual(
      new Set(["step.started", "agent.spawned", "agent.message", "step.completed"]),
    );
    const state = foldRun(logOf(events, plan));
    expect(state.steps.map((entry) => [entry.id, entry.status])).toEqual([
      ["resolve", "succeeded"],
      ["topic", "succeeded"],
    ]);
  });

  it("never starts more members than the plan declares", async () => {
    const { ctx } = testRun({ provider: scriptedProvider("fake", []) });
    const seen: { outcome?: TeamOutcome } = {};
    const started: string[] = [];
    await orchestrate(ctx, {
      plan: [resolveStep, topicStep({ ...TEAM, size: 2 })],
      version: 1,
      executors: executors(
        (member) => {
          started.push(member.assignment.id);
          return Promise.resolve(memberResult(member.assignment.id));
        },
        seen,
        ["a", "b", "c"],
      ),
    });
    expect(started).toEqual(["a", "b"]);
    expect(seen.outcome?.members.map((member) => member.status)).toEqual([
      "finished",
      "finished",
      "not_started",
    ]);
  });

  it("keeps the declared size across several rounds of one step", async () => {
    const { ctx } = testRun({ provider: scriptedProvider("fake", []) });
    const rounds: number[] = [];
    const library = executors(() => Promise.resolve(memberResult("a"))).map((entry) =>
      entry.id !== "topic"
        ? entry
        : {
            ...entry,
            run: async (task: Parameters<StepExecutor["run"]>[0]) => {
              for (const ids of [["a", "b"], ["c", "d"], ["e"]]) {
                const outcome = await task.team?.run({
                  assignments: ids.map((id) => ({ id, objective: id })),
                  role: "researcher",
                  modelRole: "fast",
                  member: (member) => Promise.resolve(memberResult(member.assignment.id)),
                });
                rounds.push(
                  outcome?.members.filter((member) => member.status === "finished").length ?? 0,
                );
              }
              return memberResult("solo");
            },
          },
    );
    await orchestrate(ctx, { plan: [resolveStep, topicStep()], version: 1, executors: library });
    expect(rounds).toEqual([2, 1, 0]);
  });

  it("counts team members across the steps of a run", async () => {
    const { ctx } = testRun({ provider: scriptedProvider("fake", []) });
    const library = executors((member) => Promise.resolve(memberResult(member.assignment.id))).map(
      (entry) =>
        entry.id === "topic"
          ? { ...entry, team: { maxMembers: 6, reducers: ["merge_findings" as const] } }
          : entry,
    );
    const six = { ...TEAM, size: 6 };
    const started: number[] = [];
    const counting = library.map((entry) =>
      entry.id !== "topic"
        ? entry
        : {
            ...entry,
            run: async (task: Parameters<StepExecutor["run"]>[0]) => {
              const outcome = await task.team?.run({
                assignments: ["a", "b", "c", "d", "e", "f"].map((id) => ({ id, objective: id })),
                role: "researcher",
                modelRole: "fast",
                member: (member) => Promise.resolve(memberResult(member.assignment.id)),
              });
              started.push(
                outcome?.members.filter((member) => member.status === "finished").length ?? 0,
              );
              return outcome?.result ?? memberResult("solo");
            },
          },
    );
    await orchestrate(ctx, {
      plan: [
        resolveStep,
        { ...topicStep(six), budgetShare: 0.2 },
        { ...topicStep(six, "topic_2"), budgetShare: 0.2 },
        { ...topicStep(six, "topic_3"), budgetShare: 0.2 },
      ],
      version: 1,
      concurrency: 1,
      executors: counting,
    });
    expect(started).toEqual([6, 6, 0]);
  });

  it("gives a member the step's grant or less, and the policy check still applies", async () => {
    const { ctx, events } = testRun({ provider: scriptedProvider("fake", []) });
    const grants: (readonly string[])[] = [];
    const write = defineTool({
      name: "write_artifact",
      description: "write",
      capability: CAPABILITIES.artifactWrite,
      inputSchema: z.object({}),
      targetDomain: () => undefined,
      summariseArgs: () => "write",
      execute: () => Promise.resolve({ summary: "written", forModel: "written" }),
    });
    const library = executors(() => Promise.resolve(memberResult("a"))).map((entry) =>
      entry.id !== "topic"
        ? entry
        : {
            ...entry,
            run: async (task: Parameters<StepExecutor["run"]>[0]) => {
              const outcome = await task.team?.run({
                assignments: [
                  { id: "a", objective: "a" },
                  {
                    id: "b",
                    objective: "b",
                    capabilities: [CAPABILITIES.artifactWrite, CAPABILITIES.sandboxExec],
                  },
                ],
                role: "researcher",
                modelRole: "fast",
                member: async (member) => {
                  grants[member.index] = member.grant.capabilities;
                  const denied = await executeToolCall(
                    member.ctx,
                    member.grant,
                    [write],
                    { name: "write_artifact", argumentsJson: "{}" },
                    { actor: { type: "agent", id: member.agent.agentId } },
                  );
                  expect(denied.ok).toBe(false);
                  return memberResult(member.assignment.id);
                },
              });
              return outcome?.result ?? memberResult("solo");
            },
          },
    );
    await orchestrate(ctx, { plan: [resolveStep, topicStep()], version: 1, executors: library });
    expect(grants).toEqual([[CAPABILITIES.webFetch], []]);
    const denials = events.filter(
      (event) => event.type === "policy.decided" && event.payload.decision === "deny",
    );
    expect(denials).toHaveLength(2);
    expect(denials.every((event) => "stepId" in event && event.stepId === "topic")).toBe(true);
  });

  it("charges members to the step budget and stops a member at its allowance", async () => {
    const provider = scriptedProvider("fake", () => textTurn("ok"));
    const { ctx } = testRun({ provider });
    const seen: { outcome?: TeamOutcome } = {};
    const outcome = await orchestrate(ctx, {
      plan: [resolveStep, topicStep({ ...TEAM, memberTokens: 2_000 })],
      version: 1,
      executors: executors(async (member) => {
        const calls = member.assignment.id === "b" ? 14 : 1;
        for (let call = 0; call < calls; call += 1)
          await callModel(member.ctx, {
            role: "fast",
            stepId: "topic",
            request: {
              system: "s",
              messages: [{ role: "user", content: "u" }],
              maxTokens: 50,
            },
          });
        return memberResult(member.assignment.id);
      }, seen),
    });
    expect(seen.outcome?.members.map((member) => member.status)).toEqual([
      "finished",
      "over_budget",
      "finished",
    ]);
    expect(outcome.statuses.get("topic")).toBe("succeeded");
    expect(outcome.results.get("topic")?.findings).toHaveLength(2);
    expect(ctx.budget.spent("topic").tokens).toBe(160 * 15);
  });

  it("leaves out a member that fails or misses its deadline, and keeps the rest", async () => {
    const { ctx, events } = testRun({ provider: scriptedProvider("fake", []) });
    const seen: { outcome?: TeamOutcome } = {};
    let aborted = false;
    const outcome = await orchestrate(ctx, {
      plan: [resolveStep, topicStep({ ...TEAM, memberMs: 30 })],
      version: 1,
      executors: executors((member) => {
        if (member.assignment.id === "a") return Promise.reject(new Error("search failed"));
        if (member.assignment.id === "b")
          return new Promise<SubAgentResult>((_resolve, reject) => {
            member.ctx.signal?.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("aborted"));
            });
          });
        return Promise.resolve(memberResult("c"));
      }, seen),
    });
    expect(aborted).toBe(true);
    expect(seen.outcome?.members.map((member) => member.status)).toEqual([
      "failed",
      "timed_out",
      "finished",
    ]);
    expect(outcome.statuses.get("topic")).toBe("succeeded");
    expect(outcome.results.get("topic")?.findings.map((entry) => entry.text)).toEqual([
      "fact from c",
    ]);
    expect(
      events.flatMap((event) => (event.type === "agent.message" ? [event.payload.text] : [])),
    ).toEqual(
      expect.arrayContaining([
        "This team member failed; the others continue.",
        "Stopped: no result within 0 s.",
      ]),
    );
  });

  it("fails the step, and the run, on a fatal member error", async () => {
    const { ctx } = testRun({ provider: scriptedProvider("fake", []) });
    const outcome = await orchestrate(ctx, {
      plan,
      version: 1,
      executors: executors((member) =>
        member.assignment.id === "b"
          ? Promise.reject(new FatalStepError("robots_disallowed", "robots.txt disallows it"))
          : Promise.resolve(memberResult(member.assignment.id)),
      ),
    });
    expect(outcome.statuses.get("topic")).toBe("failed");
    expect(outcome.fatal).toBeInstanceOf(FatalStepError);
  });

  it("treats an exhausted run budget as fatal, as for any step", async () => {
    const provider = scriptedProvider("fake", () => textTurn("ok"));
    const { ctx } = testRun({ provider, maxTokens: 200 });
    const outcome = await orchestrate(ctx, {
      plan,
      version: 1,
      executors: executors(async (member) => {
        await callModel(member.ctx, {
          role: "fast",
          stepId: "topic",
          request: { system: "s", messages: [{ role: "user", content: "u" }], maxTokens: 50 },
        });
        return memberResult(member.assignment.id);
      }),
    });
    expect(outcome.fatal).toBeInstanceOf(BudgetExceededError);
  });

  it("runs the single-agent path when the plan step declares no team", async () => {
    const { ctx } = testRun({ provider: scriptedProvider("fake", []) });
    const seen: { hadTeam?: boolean } = {};
    await orchestrate(ctx, {
      plan: [resolveStep, topicStep(null)],
      version: 1,
      executors: executors(() => Promise.resolve(memberResult("a")), seen),
    });
    expect(seen.hadTeam).toBe(false);
  });
});

describe("durability of a team step", () => {
  const plan = [resolveStep, topicStep()];

  async function finishedLog() {
    const { ctx, events } = testRun({ provider: scriptedProvider("fake", []) });
    await orchestrate(ctx, {
      plan,
      version: 1,
      executors: executors((member) => Promise.resolve(memberResult(member.assignment.id))),
    });
    return events;
  }

  it("restores a finished team step from its checkpoint without running a member again", async () => {
    const events = await finishedLog();
    const analysis = analyseForResume(logOf(events, plan));
    if (analysis.kind !== "resumable" || analysis.point === undefined)
      throw new Error("expected a resumable run");
    expect(analysis.completedSteps).toEqual(["resolve", "topic"]);
    expect(analysis.point.steps[1]?.team).toEqual(TEAM);
    const { ctx, events: resumed } = testRun({ provider: scriptedProvider("fake", []) });
    let members = 0;
    const outcome = await orchestrate(ctx, {
      plan: analysis.point.steps,
      version: analysis.point.version,
      resume: { completed: analysis.point.completed, failed: analysis.point.failed },
      executors: executors(() => {
        members += 1;
        return Promise.resolve(memberResult("a"));
      }),
    });
    expect(members).toBe(0);
    expect(resumed).toEqual([]);
    expect(outcome.results.get("topic")?.findings).toHaveLength(3);
  });

  it("runs a team step that was in flight at the crash again with all its members", async () => {
    const events = await finishedLog();
    const cut = events.findIndex(
      (event) => event.type === "step.completed" && event.stepId === "topic",
    );
    const analysis = analyseForResume(logOf(events.slice(0, cut), plan));
    if (analysis.kind !== "resumable" || analysis.point === undefined)
      throw new Error("expected a resumable run");
    expect(analysis.rerunSteps).toEqual(["topic"]);
    const { ctx } = testRun({ provider: scriptedProvider("fake", []) });
    const started: string[] = [];
    await orchestrate(ctx, {
      plan: analysis.point.steps,
      version: analysis.point.version,
      resume: { completed: analysis.point.completed, failed: analysis.point.failed },
      executors: executors((member) => {
        started.push(member.assignment.id);
        return Promise.resolve(memberResult(member.assignment.id));
      }),
    });
    expect(started).toEqual(["a", "b", "c"]);
  });

  it("forks from a team step with the declaration intact and none of its member events", async () => {
    const events = await finishedLog();
    const log = logOf(
      [...events, { runId: "run_1", type: "run.completed", payload: { summary: "done" } }],
      plan,
    );
    const fork = planFork(log, { stepId: "topic" });
    if (!fork.ok) throw new Error(fork.message);
    expect(fork.steps[1]?.team).toEqual(TEAM);
    expect(fork.reusedSteps).toEqual(["resolve"]);
    expect(fork.seed.some((event) => "stepId" in event && event.stepId === "topic")).toBe(false);
  });
});

describe("the planner and teams", () => {
  const library = executors(() => Promise.resolve(memberResult("a")));
  const prompt = parsePromptFile(
    "planner.v4.md",
    readFileSync(new URL("../../prompts/planner.v4.md", import.meta.url), "utf8"),
  );
  const defaultPlan = [resolveStep, topicStep()];
  const answer = (steps: PlanStep[]) => textTurn(JSON.stringify({ steps, rationale: "ok" }));

  it("shows team support only on the library entries that have it", async () => {
    const provider = scriptedProvider("fake", [answer(defaultPlan)]);
    const { ctx } = testRun({ provider });
    await proposePlan(ctx, { mission: mission(library), defaultPlan, prompt, usePlanner: true });
    const lines = (provider.requests[0]?.messages[0]?.content ?? "")
      .split("\n")
      .filter((line) => line.startsWith('{"id"'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).not.toContain('"team"');
    expect(lines[1]).toContain('"team":{"maxMembers":3,"reducers":["merge_findings"]}');
  });

  it("keeps a team the planner declares within the caps", async () => {
    const smaller = [resolveStep, topicStep({ ...TEAM, size: 2 })];
    const provider = scriptedProvider("fake", [answer(smaller)]);
    const proposed = await proposePlan(testRun({ provider }).ctx, {
      mission: mission(library),
      defaultPlan,
      prompt,
      usePlanner: true,
    });
    expect(proposed.source).toBe("planner");
    expect(proposed.steps[1]?.team?.size).toBe(2);
  });

  it("tells the planner which cap a team breaks and falls back to the default plan if it breaks it again", async () => {
    const tooWide = [resolveStep, topicStep({ ...TEAM, size: 5 })];
    const provider = scriptedProvider("fake", [answer(tooWide), answer(tooWide)]);
    const proposed = await proposePlan(testRun({ provider }).ctx, {
      mission: mission(library),
      defaultPlan,
      prompt,
      usePlanner: true,
    });
    expect(provider.requests[1]?.messages[2]?.content).toMatch(/allows 2 to 3 members/);
    expect(proposed.source).toBe("default");
    expect(proposed.steps[1]?.team).toEqual(TEAM);
  });
});
