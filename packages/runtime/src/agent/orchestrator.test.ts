import { CAPABILITIES } from "@delegate/policy";
import { describe, expect, it } from "vitest";

import { foldRun, parseRunEvent, type PlanStep, type RunEventDraft } from "../events";
import { scriptedProvider, testRun } from "../testing/fakes";
import { orchestrate, type Replanner } from "./orchestrator";
import { type StepExecutor, type SubAgentResult } from "./subagent";

const result = (summary: string, confidence = 0.9): SubAgentResult => ({
  summary,
  findings: [{ text: `${summary} finding`, citations: [], trust: "derived" }],
  sources: [],
  confidence,
  artifacts: [],
});

const step = (id: string, inputs: string[] = [], budgetShare = 0.1): PlanStep => ({
  id,
  role: "analyst",
  objective: `Do ${id}`,
  inputs,
  capabilities: [CAPABILITIES.webFetch],
  acceptance: ["done"],
  budgetShare,
});

function executor(
  id: string,
  run: StepExecutor["run"],
  extra: Partial<StepExecutor> = {},
): StepExecutor {
  return {
    id,
    role: "analyst",
    modelRole: "worker",
    capabilities: [CAPABILITIES.webFetch],
    description: id,
    run,
    ...extra,
  };
}

function harness() {
  const { ctx, events } = testRun({ provider: scriptedProvider("fake", []) });
  return { ctx, events };
}

function fold(events: readonly RunEventDraft[], plan: readonly PlanStep[]) {
  const head: RunEventDraft[] = [
    {
      runId: "run_1",
      type: "run.created",
      payload: {
        workspaceId: "ws_1",
        missionId: "company-xray",
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
  return foldRun(
    [...head, ...events].map((event, index) =>
      parseRunEvent({ ...event, seq: index + 1, at: "2026-11-24T10:00:00.000Z" }),
    ),
  );
}

describe("orchestrate", () => {
  it("never grants a step more capabilities than its executor declares", async () => {
    const { ctx } = harness();
    let granted: readonly string[] = [];
    const widened = {
      ...step("a"),
      capabilities: [CAPABILITIES.webFetch, CAPABILITIES.artifactWrite, CAPABILITIES.messageSend],
    };
    await orchestrate(ctx, {
      plan: [widened],
      version: 1,
      executors: [
        executor("a", (task) => {
          granted = task.grant.capabilities;
          return Promise.resolve(result("a"));
        }),
      ],
    });
    expect(granted).toEqual([CAPABILITIES.webFetch]);
  });

  it("runs independent steps in parallel up to the concurrency limit and respects dependencies", async () => {
    const { ctx, events } = harness();
    let active = 0;
    let peak = 0;
    const order: string[] = [];
    const seenInputs = new Map<string, string[]>();
    const work =
      (id: string): StepExecutor["run"] =>
      async (task) => {
        active += 1;
        peak = Math.max(peak, active);
        order.push(`start:${id}`);
        seenInputs.set(id, [...task.inputs.keys()]);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        order.push(`end:${id}`);
        return result(id);
      };
    const plan = [
      step("a"),
      step("b", ["a"]),
      step("c", ["a"]),
      step("d", ["a"]),
      step("e", ["a"]),
      step("f", ["b", "c", "d", "e"]),
    ];
    const outcome = await orchestrate(ctx, {
      plan,
      version: 1,
      concurrency: 2,
      executors: ["a", "b", "c", "d", "e", "f"].map((id) => executor(id, work(id))),
    });
    expect(peak).toBe(2);
    expect(order[0]).toBe("start:a");
    expect(order.indexOf("start:b")).toBeGreaterThan(order.indexOf("end:a"));
    const fStart = order.indexOf("start:f");
    for (const id of ["b", "c", "d", "e"])
      expect(fStart).toBeGreaterThan(order.indexOf(`end:${id}`));
    expect(seenInputs.get("f")?.sort()).toEqual(["a", "b", "c", "d", "e"]);
    expect([...outcome.statuses.values()].every((status) => status === "succeeded")).toBe(true);
    const spawned = events.filter((event) => event.type === "agent.spawned");
    expect(spawned).toHaveLength(6);
    const state = fold(events, plan);
    expect(state.steps.every((entry) => entry.status === "succeeded")).toBe(true);
  });

  it("replans after a failure, emits plan.revised with a diff and caps revisions at two", async () => {
    const { ctx, events } = harness();
    const plan = [step("a"), step("b", ["a"]), step("c", ["b"])];
    let calls = 0;
    const replan: Replanner = (state) => {
      calls += 1;
      const kept = state.plan.filter((entry) => entry.id !== "c");
      const retry = step(`b_${calls + 1}`, ["a"]);
      return Promise.resolve({
        steps: [...kept, retry, step("c", [retry.id])],
        reason: `retry ${calls}`,
      });
    };
    const outcome = await orchestrate(ctx, {
      plan,
      version: 1,
      replan,
      executors: [
        executor("a", () => Promise.resolve(result("a"))),
        executor("b", () => Promise.reject(new Error("upstream 500")), { repeatable: true }),
        executor("c", () => Promise.resolve(result("c"))),
      ],
    });
    expect(calls).toBe(2);
    expect(outcome.revisions).toBe(2);
    expect(outcome.version).toBe(3);
    const revised = events.filter((event) => event.type === "plan.revised");
    expect(revised).toHaveLength(2);
    expect(revised[0]).toMatchObject({
      payload: { version: 2, diff: { added: ["b_2"], removed: [], changed: ["c"] } },
    });
    expect(outcome.statuses.get("b")).toBe("failed");
    expect(outcome.statuses.get("b_2")).toBe("failed");
    expect(outcome.statuses.get("b_3")).toBe("failed");
    expect(outcome.statuses.get("c")).toBe("succeeded");
    const state = fold(events, plan);
    expect(state.planRevisions.map((revision) => revision.version)).toEqual([2, 3]);
    expect(state.plan?.version).toBe(3);
  });

  it("counts failed replanning attempts toward the cap", async () => {
    const { ctx } = harness();
    let calls = 0;
    await orchestrate(ctx, {
      plan: [
        step("a"),
        step("b", ["a"]),
        step("c", ["a"]),
        step("d", ["a"]),
        step("e", ["b", "c", "d"]),
      ],
      version: 1,
      replan: () => {
        calls += 1;
        return Promise.resolve(null);
      },
      executors: [
        executor("a", () => Promise.resolve(result("a"))),
        ...["b", "c", "d"].map((id) =>
          executor(id, () => Promise.reject(new Error(`${id} failed`))),
        ),
        executor("e", () => Promise.resolve(result("e"))),
      ],
    });
    expect(calls).toBe(2);
  });

  it("replans on low confidence only when the step asks for it", async () => {
    const { ctx } = harness();
    const triggers: string[] = [];
    const replan: Replanner = (state) => {
      triggers.push(state.trigger.reason);
      return Promise.resolve(null);
    };
    await orchestrate(ctx, {
      plan: [step("a"), step("b", ["a"]), step("c", ["b"])],
      version: 1,
      replan,
      executors: [
        executor("a", () => Promise.resolve(result("a", 0.2))),
        executor("b", () =>
          Promise.resolve({ ...result("b", 0.3), needsReplan: { reason: "only 1 page read" } }),
        ),
        executor("c", () => Promise.resolve(result("c"))),
      ],
    });
    expect(triggers).toEqual(["Low confidence (0.30): only 1 page read"]);
  });

  it("does not run a step whose required input failed, but runs steps that can do without it", async () => {
    const { ctx, events } = harness();
    let ranOptional = false;
    const plan = [step("a"), step("b", ["a"]), step("c", ["a"])];
    const outcome = await orchestrate(ctx, {
      plan,
      version: 1,
      executors: [
        executor("a", () => Promise.reject(new Error("boom"))),
        executor("b", () => Promise.resolve(result("b")), { needs: ["a"] }),
        executor("c", (task) => {
          ranOptional = task.inputs.size === 0;
          return Promise.resolve(result("c"));
        }),
      ],
    });
    expect(outcome.statuses.get("b")).toBe("failed");
    expect(ranOptional).toBe(true);
    expect(events.some((event) => event.type === "step.started" && event.stepId === "b")).toBe(
      false,
    );
    expect(fold(events, plan).steps.find((entry) => entry.id === "b")?.summary).toMatch(/needs a/);
  });

  it("stops scheduling after a fatal error", async () => {
    const { ctx } = harness();
    const { FatalStepError } = await import("./subagent");
    let ranLater = false;
    const outcome = await orchestrate(ctx, {
      plan: [step("a"), step("b", ["a"])],
      version: 1,
      executors: [
        executor("a", () => Promise.reject(new FatalStepError("site_unreachable", "down"))),
        executor("b", () => {
          ranLater = true;
          return Promise.resolve(result("b"));
        }),
      ],
    });
    expect(outcome.fatal).toBeInstanceOf(FatalStepError);
    expect(ranLater).toBe(false);
  });
});
