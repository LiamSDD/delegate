import { parseRunEvent, type RunEvent, type RunEventDraft } from "@delegate/runtime";
import { describe, expect, it } from "vitest";

import { buildTrace } from "./trace";

const RUN = "00000000-0000-4000-8000-000000000001";
const T0 = Date.parse("2026-11-24T10:00:00.000Z");

type Draft = RunEventDraft extends infer D ? (D extends unknown ? Omit<D, "runId"> : never) : never;

function log(entries: [number, Draft][]): RunEvent[] {
  return entries.map(([ms, draft], index) =>
    parseRunEvent({ ...draft, runId: RUN, seq: index + 1, at: new Date(T0 + ms).toISOString() }),
  );
}

const usage = {
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 300,
  cacheWriteTokens: 0,
  costMicroUsd: 0,
  provider: "pollinations",
  model: "kimi-k3",
};

const events = log([
  [
    0,
    {
      type: "run.created",
      payload: {
        workspaceId: "w",
        missionId: "automation-audit",
        input: { url: "https://acme.test/" },
        actor: { type: "guest", id: "u" },
        budget: { maxTokens: 1, maxMicroUsd: 0 },
      },
    },
  ],
  [
    100,
    {
      type: "plan.proposed",
      payload: {
        version: 1,
        steps: [
          {
            id: "map",
            role: "researcher",
            objective: "Map the site",
            inputs: [],
            capabilities: ["fetch"],
            acceptance: ["ok"],
            budgetShare: 0.5,
          },
        ],
      },
    },
  ],
  [200, { type: "step.started", stepId: "map", payload: {} }],
  [
    300,
    {
      type: "agent.spawned",
      stepId: "map",
      agentId: "r1",
      payload: { role: "researcher", modelRole: "worker" },
    },
  ],
  [
    400,
    {
      type: "policy.decided",
      stepId: "map",
      payload: { tool: "fetch", decision: "allow", policyId: "egress", reason: "public" },
    },
  ],
  [
    450,
    {
      type: "tool.called",
      stepId: "map",
      agentId: "r1",
      payload: {
        toolCallId: "c1",
        tool: "fetch",
        capability: "fetch",
        argsSummary: "https://acme.test/",
      },
    },
  ],
  [
    950,
    {
      type: "tool.result",
      stepId: "map",
      agentId: "r1",
      payload: { toolCallId: "c1", tool: "fetch", ok: true, summary: "12 kB", durationMs: 500 },
    },
  ],
  [1500, { type: "usage.updated", stepId: "map", agentId: "r1", payload: usage }],
  [
    1600,
    {
      type: "step.completed",
      stepId: "map",
      payload: { outcome: "succeeded", summary: "Mapped", artifactIds: [] },
    },
  ],
  [2000, { type: "run.completed", payload: { summary: "done" } }],
]);

describe("buildTrace", () => {
  it("nests run → step → agent → tool/model spans positioned by time", () => {
    const trace = buildTrace(events, T0 + 5000);
    expect(trace.durationMs).toBe(2000);
    const byKind = (kind: string) => trace.spans.filter((span) => span.kind === kind);
    const [run] = byKind("run");
    const [step] = byKind("step");
    const [agent] = byKind("agent");
    const [tool] = byKind("tool");
    const [model] = byKind("model");
    const [policy] = byKind("policy");
    expect(run).toMatchObject({ parentId: null, startMs: 0, endMs: 2000, depth: 0 });
    expect(step).toMatchObject({ parentId: run?.id, startMs: 200, endMs: 1600, depth: 1 });
    expect(agent).toMatchObject({ parentId: step?.id, startMs: 300, endMs: 1600, depth: 2 });
    expect(tool).toMatchObject({ parentId: agent?.id, startMs: 450, endMs: 950, status: "ok" });
    expect(tool?.input).toBe("https://acme.test/");
    expect(tool?.output).toBe("12 kB");
    expect(model).toMatchObject({ parentId: agent?.id, startMs: 950, endMs: 1500 });
    expect(model?.attrs).toMatchObject({
      provider: "pollinations",
      model: "kimi-k3",
      inputTokens: 1000,
    });
    expect(policy).toMatchObject({ parentId: step?.id, startMs: 400, endMs: 400 });
    expect(run?.attrs.inputTokens).toBe(1000);
    expect(trace.spans.map((span) => span.kind)).toEqual([
      "run",
      "step",
      "agent",
      "tool",
      "model",
      "policy",
    ]);
  });

  it("keeps open spans running until now", () => {
    const trace = buildTrace(events.slice(0, 6), T0 + 3000);
    const tool = trace.spans.find((span) => span.kind === "tool");
    expect(tool).toMatchObject({ status: "running", endMs: 3000 });
    expect(trace.spans[0]?.status).toBe("running");
  });
});
