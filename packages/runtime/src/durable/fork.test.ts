import { describe, expect, it } from "vitest";

import { foldRun, parseRunEvent, type PlanStep, type RunEvent } from "../events";
import { analyseForResume } from "./checkpoints";
import { assembleForkLog, forkableSteps, planFork } from "./fork";

const parentId = "run_parent";
const at = "2026-11-25T10:00:00.000Z";

const step = (id: string, inputs: string[] = []): PlanStep => ({
  id,
  role: "researcher",
  objective: `Objective for ${id}`,
  inputs,
  capabilities: [],
  acceptance: ["done"],
  budgetShare: 0.3,
});

const plan = [step("crawl"), step("index", ["crawl"]), step("write", ["index"])];

const checkpoint = (summary: string) => ({
  summary,
  findings: [],
  sources: [],
  confidence: 0.8,
  artifacts: [],
});

function log(drafts: Record<string, unknown>[], runId = parentId): RunEvent[] {
  return drafts.map((draft, index) => parseRunEvent({ runId, seq: index + 1, at, ...draft }));
}

const created = {
  type: "run.created",
  payload: {
    workspaceId: "ws_1",
    missionId: "build-agent",
    input: { url: "https://example.com", goal: "Answer support questions" },
    actor: { type: "guest", id: "guest_1" },
    budget: { maxTokens: 1000, maxMicroUsd: 0 },
  },
};

function completedRun(): RunEvent[] {
  return log([
    created,
    { type: "plan.proposed", payload: { version: 1, steps: plan } },
    { type: "plan.approved", payload: { version: 1, approvedBy: { type: "system", id: "auto" } } },
    { type: "step.started", stepId: "crawl", payload: {} },
    {
      type: "artifact.created",
      stepId: "crawl",
      payload: { artifactId: "corpus", kind: "corpus", title: "Corpus", version: 1, content: [] },
    },
    {
      type: "step.completed",
      stepId: "crawl",
      payload: {
        outcome: "succeeded",
        summary: "crawled",
        artifactIds: ["corpus"],
        checkpoint: checkpoint("crawled"),
      },
    },
    {
      type: "policy.decided",
      payload: {
        tool: "run.resume",
        decision: "allow",
        policyId: "durable-resume",
        reason: "resumed",
      },
    },
    { type: "step.started", stepId: "index", payload: {} },
    {
      type: "step.completed",
      stepId: "index",
      payload: {
        outcome: "succeeded",
        summary: "indexed",
        artifactIds: [],
        checkpoint: checkpoint("indexed"),
      },
    },
    { type: "step.started", stepId: "write", payload: {} },
    {
      type: "step.completed",
      stepId: "write",
      payload: { outcome: "failed", summary: "model refused", artifactIds: [] },
    },
    { type: "run.failed", payload: { error: { code: "mission_failed", message: "failed" } } },
  ]);
}

function forkCreated(origin: Record<string, unknown>): RunEvent {
  return parseRunEvent({
    runId: "run_fork",
    seq: 1,
    at,
    type: "run.created",
    payload: { ...created.payload, forkedFrom: origin },
  });
}

describe("forkableSteps", () => {
  it("lists steps that finished, with their outcome, only for terminal runs", () => {
    const events = completedRun();
    expect(forkableSteps(events)).toEqual([
      { id: "crawl", objective: "Objective for crawl", outcome: "succeeded" },
      { id: "index", objective: "Objective for index", outcome: "succeeded" },
      { id: "write", objective: "Objective for write", outcome: "failed" },
    ]);
    expect(forkableSteps(events.slice(0, -1))).toEqual([]);
  });
});

describe("planFork", () => {
  it("copies every event before the chosen step started, except run.created", () => {
    const events = completedRun();
    const fork = planFork(events, { stepId: "index" });
    expect(fork.ok).toBe(true);
    if (!fork.ok) return;
    expect(fork.seed.map((event) => event.type)).toEqual([
      "plan.proposed",
      "plan.approved",
      "step.started",
      "artifact.created",
      "step.completed",
      "policy.decided",
    ]);
    expect(fork.parentSeq).toBe(7);
    expect(fork.reusedSteps).toEqual(["crawl"]);
    expect(fork.objectiveEdited).toBe(false);
  });

  it("drops events the caller filters out", () => {
    const fork = planFork(completedRun(), {
      stepId: "index",
      keep: (event) =>
        !(event.type === "policy.decided" && event.payload.policyId === "durable-resume"),
    });
    expect(fork.ok && fork.seed.some((event) => event.type === "policy.decided")).toBe(false);
  });

  it("records an edited objective as a plan revision that keeps approval", () => {
    const fork = planFork(completedRun(), { stepId: "index", objective: "  Index only docs  " });
    expect(fork.ok).toBe(true);
    if (!fork.ok) return;
    const revision = fork.seed.at(-1);
    expect(revision?.type).toBe("plan.revised");
    if (revision?.type !== "plan.revised") return;
    expect(revision.payload.version).toBe(2);
    expect(revision.payload.diff).toEqual({ added: [], removed: [], changed: ["index"] });
    expect(fork.steps.find((s) => s.id === "index")?.objective).toBe("Index only docs");
    const state = foldRun(
      assembleForkLog(
        forkCreated({
          runId: parentId,
          stepId: "index",
          parentSeq: 7,
          seededThrough: 8,
          objectiveEdited: true,
        }),
        fork.seed,
      ),
    );
    expect(state.plan?.approved).toBe(true);
    expect(state.plan?.version).toBe(2);
  });

  it("treats an unchanged or blank objective as not edited", () => {
    const same = planFork(completedRun(), { stepId: "index", objective: "Objective for index" });
    const blank = planFork(completedRun(), { stepId: "index", objective: "   " });
    expect(same.ok && same.objectiveEdited).toBe(false);
    expect(blank.ok && blank.objectiveEdited).toBe(false);
  });

  it("refuses unfinished runs, unknown steps and steps that never finished", () => {
    const events = completedRun();
    expect(planFork(events.slice(0, -1), { stepId: "index" })).toMatchObject({
      ok: false,
      reason: "run_not_finished",
    });
    expect(planFork(events, { stepId: "nope" })).toMatchObject({
      ok: false,
      reason: "unknown_step",
    });
    const cancelledEarly = log([
      ...completedRun()
        .slice(0, 6)
        .map(({ runId: _r, seq: _s, at: _a, ...rest }) => rest),
      { type: "run.failed", payload: { error: { code: "cancelled", message: "cancelled" } } },
    ]);
    expect(planFork(cancelledEarly, { stepId: "index" })).toMatchObject({
      ok: false,
      reason: "step_not_completed",
    });
  });

  it("seeds a log that resume continues from the chosen step, reusing earlier checkpoints", () => {
    const fork = planFork(completedRun(), { stepId: "index" });
    if (!fork.ok) throw new Error("fork refused");
    const origin = {
      runId: parentId,
      stepId: "index",
      parentSeq: fork.parentSeq,
      seededThrough: fork.seed.length + 1,
      objectiveEdited: false,
    };
    const forked = assembleForkLog(forkCreated(origin), fork.seed);
    expect(forked.every((event) => event.runId === "run_fork")).toBe(true);
    expect(forked.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(foldRun(forked).forkedFrom).toEqual(origin);
    const analysis = analyseForResume(forked);
    expect(analysis.kind).toBe("resumable");
    if (analysis.kind !== "resumable") return;
    expect(analysis.completedSteps).toEqual(["crawl"]);
    expect(analysis.rerunSteps).toEqual(["index", "write"]);
    expect(analysis.artifacts.map((artifact) => artifact.artifactId)).toEqual(["corpus"]);
    expect(analysis.point?.approved).toBe(true);
  });

  it("forking from the first step keeps only the approved plan", () => {
    const fork = planFork(completedRun(), { stepId: "crawl" });
    if (!fork.ok) throw new Error("fork refused");
    expect(fork.seed.map((event) => event.type)).toEqual(["plan.proposed", "plan.approved"]);
    expect(fork.reusedSteps).toEqual([]);
  });
});
