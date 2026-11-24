import type { RunEvent } from "@delegate/runtime";
import { describe, expect, it } from "vitest";

import { buildLanes } from "./lanes";

let seq = 0;
function ev<T extends RunEvent["type"]>(
  type: T,
  payload: Extract<RunEvent, { type: T }>["payload"],
  extra: { stepId?: string; agentId?: string } = {},
): RunEvent {
  seq += 1;
  return {
    runId: "r",
    seq,
    at: `2026-11-24T10:00:${String(seq).padStart(2, "0")}.000Z`,
    type,
    payload,
    ...extra,
  } as RunEvent;
}

const usage = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costMicroUsd: 0,
  provider: "llm7",
  model: "gpt-oss-120b",
};

describe("buildLanes", () => {
  it("groups activity per spawned sub-agent with role, model and status", () => {
    seq = 0;
    const events = [
      ev(
        "agent.spawned",
        { role: "researcher", modelRole: "worker" },
        { stepId: "a", agentId: "r1" },
      ),
      ev(
        "agent.spawned",
        { role: "analyst", modelRole: "planner" },
        { stepId: "b", agentId: "n1" },
      ),
      ev(
        "tool.called",
        { toolCallId: "t1", tool: "fetch", capability: "fetch", argsSummary: "x" },
        { stepId: "a" },
      ),
      ev("agent.message", { text: "hi" }, { stepId: "b", agentId: "n1" }),
      ev("usage.updated", usage, { stepId: "b", agentId: "n1" }),
      ev("critic.flagged", {
        claimId: "c",
        claim: "Claim",
        reason: "Unsupported",
        severity: "warn",
        category: "claim",
      }),
      ev(
        "step.completed",
        { outcome: "succeeded", summary: "ok", artifactIds: [] },
        { stepId: "a" },
      ),
    ];
    const lanes = buildLanes(events);
    expect(lanes.map((lane) => lane.id)).toEqual(["r1", "n1", "run"]);
    expect(lanes[0]).toMatchObject({ role: "researcher", status: "done" });
    expect(lanes[0]?.items.map((item) => item.kind)).toEqual(["tool"]);
    expect(lanes[1]).toMatchObject({
      role: "analyst",
      status: "running",
      model: "llm7 · gpt-oss-120b",
    });
    expect(lanes[2]?.items.map((item) => item.kind)).toEqual(["flag"]);
  });
});
