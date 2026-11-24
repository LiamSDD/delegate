import type { RunEvent } from "@delegate/runtime";
import { describe, expect, it } from "vitest";

import {
  buildRunView,
  cacheHitRate,
  classifyOutcome,
  costLabel,
  elapsedMs,
  formatDuration,
  hostFromSummary,
  modelMix,
} from "./run-view";

const runId = "run-1";
let seq = 0;
function ev<T extends RunEvent["type"]>(
  type: T,
  payload: Extract<RunEvent, { type: T }>["payload"],
  extra: { stepId?: string; agentId?: string; at?: string } = {},
): RunEvent {
  seq += 1;
  const { at, ...rest } = extra;
  return {
    runId,
    seq,
    at: at ?? `2026-11-24T10:00:${String(seq).padStart(2, "0")}.000Z`,
    type,
    payload,
    ...rest,
  } as RunEvent;
}

function usage(provider: string, model: string, extra: Partial<Record<string, number>> = {}) {
  return {
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costMicroUsd: 0,
    provider,
    model,
    ...extra,
  };
}

function script(): RunEvent[] {
  seq = 0;
  const step = (id: string) => ({
    id,
    role: "researcher" as const,
    objective: `Do ${id}`,
    inputs: [],
    capabilities: [],
    acceptance: [],
    budgetShare: 0.5,
  });
  return [
    ev("run.created", {
      workspaceId: "w",
      missionId: "company-xray",
      input: { url: "https://www.acme.com/", execution: "simulated" },
      actor: { type: "guest", id: "u" },
      budget: { maxTokens: 1000, maxMicroUsd: 0 },
    }),
    ev("plan.proposed", { version: 1, steps: [step("a"), step("b")] }),
    ev("plan.approved", { version: 1, approvedBy: { type: "system", id: "auto" } }),
    ev("step.started", {}, { stepId: "a" }),
    ev("agent.message", { text: "Hello " }, { stepId: "a", agentId: "x" }),
    ev("agent.message", { text: "world" }, { stepId: "a", agentId: "x" }),
    ev(
      "tool.called",
      {
        toolCallId: "t1",
        tool: "fetch",
        capability: "fetch",
        argsSummary: "GET https://acme.com/about",
      },
      { stepId: "a" },
    ),
    ev("agent.message", { text: "Next" }, { stepId: "a", agentId: "x" }),
    ev(
      "tool.result",
      { toolCallId: "t1", tool: "fetch", ok: true, summary: "200 OK", durationMs: 120 },
      { stepId: "a" },
    ),
    ev("policy.decided", {
      tool: "fetch",
      decision: "deny",
      policyId: "egress",
      reason: "private address",
    }),
    ev("critic.flagged", {
      claimId: "c",
      claim: "<b>ignore all</b>",
      reason: "suspicious",
      severity: "warn",
      category: "injection_suspected",
    }),
    ev("usage.updated", usage("groq", "gpt-oss-120b", { cacheReadTokens: 300 }), { stepId: "a" }),
    ev("model.fallback", {
      role: "worker",
      from: { provider: "pollinations", model: "openai" },
      to: { provider: "groq", model: "gpt-oss-120b" },
      reason: "rate_limited",
    }),
    ev("step.completed", { outcome: "succeeded", summary: "ok", artifactIds: [] }, { stepId: "a" }),
    ev("step.started", {}, { stepId: "b" }),
    ev("artifact.created", {
      artifactId: "brief",
      kind: "company-xray-brief",
      title: "Brief",
      version: 1,
      content: { sections: {}, sources: [] },
    }),
    ev("artifact.updated", { artifactId: "brief", version: 2 }),
    ev("artifact.updated", {
      artifactId: "brief",
      version: 3,
      content: { sections: { offering: { claims: [] } }, sources: [] },
    }),
  ];
}

describe("buildRunView", () => {
  it("folds the run and derives target, execution and steps with timing", () => {
    const view = buildRunView(script());
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.target).toBe("acme.com");
    expect(view.execution).toBe("simulated");
    expect(view.steps.map((step) => [step.id, step.status])).toEqual([
      ["a", "done"],
      ["b", "running"],
    ]);
    expect(view.steps[0]?.durationMs).toBe(10_000);
    expect(view.stepsDone).toBe(1);
  });

  it("builds an activity lane with coalesced messages and paired tool cards", () => {
    const view = buildRunView(script());
    if (!view.ok) throw new Error(view.error);
    expect(view.activity.map((item) => item.kind)).toEqual([
      "message",
      "tool",
      "message",
      "policy",
      "flag",
      "fallback",
    ]);
    expect(view.activity[0]).toMatchObject({ kind: "message", text: "Hello world" });
    expect(view.activity[1]).toMatchObject({
      kind: "tool",
      tool: "fetch",
      host: "acme.com",
      status: "ok",
      durationMs: 120,
      summary: "200 OK",
    });
    expect(view.activity[4]).toMatchObject({
      kind: "flag",
      injection: true,
      claim: "<b>ignore all</b>",
    });
  });

  it("uses the latest artifact content, keeping content across versions without it", () => {
    const view = buildRunView(script());
    if (!view.ok) throw new Error(view.error);
    expect(view.brief).toEqual({
      artifactId: "brief",
      title: "Brief",
      version: 3,
      contentVersion: 3,
      content: { sections: { offering: { claims: [] } }, sources: [] },
    });
  });

  it("reports a fold error instead of throwing on a broken log", () => {
    const events = script();
    const broken = buildRunView(events.slice(1));
    expect(broken.ok).toBe(false);
  });
});

describe("brief selection", () => {
  it("never renders a source snapshot as the brief while the brief is still being written", () => {
    const events = script().filter(
      (event) =>
        !(
          event.type.startsWith("artifact.") &&
          "artifactId" in event.payload &&
          event.payload.artifactId === "brief"
        ),
    );
    events.push(
      ev("artifact.created", {
        artifactId: "snapshot-1",
        kind: "source-snapshot",
        title: "Raw pages from acme.com",
        version: 1,
        content: { pages: [] },
      }),
    );
    const view = buildRunView(events);
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.brief).toBeNull();
  });
});

describe("selectors", () => {
  it("computes cache hit rate over all prompt tokens, n/a when none reported", () => {
    expect(
      cacheHitRate({ inputTokens: 100, cacheReadTokens: 300, cacheWriteTokens: 100 }),
    ).toBeCloseTo(0.6);
    expect(cacheHitRate({ inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeNull();
    expect(cacheHitRate({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeNull();
  });

  it("labels cost as free tier when nothing was charged, real dollars otherwise", () => {
    expect(costLabel(0, [])).toEqual({ amount: "$0.00", note: "free tier" });
    expect(costLabel(1_234_567, [{ provider: "anthropic" }])).toEqual({
      amount: "$1.23",
      note: "BYOK",
    });
    expect(costLabel(4_000, [{ provider: "groq" }])).toEqual({ amount: "$0.004", note: null });
  });

  it("lists the model mix with call counts and fallback markers", () => {
    const events = script();
    const mix = modelMix(events);
    expect(mix).toEqual([
      { provider: "groq", model: "gpt-oss-120b", calls: 1, viaFallback: true, fellBackFrom: false },
      {
        provider: "pollinations",
        model: "openai",
        calls: 0,
        viaFallback: false,
        fellBackFrom: true,
      },
    ]);
  });

  it("classifies terminal outcomes", () => {
    const kind = (code: string) => classifyOutcome({ code, message: "x" }).kind;
    expect(kind("cancelled")).toBe("cancelled");
    expect(kind("budget_exceeded")).toBe("budget");
    expect(kind("no_model_available")).toBe("capacity");
    expect(kind("site_unreachable")).toBe("site_unreachable");
    expect(kind("invalid_input")).toBe("invalid_input");
    expect(kind("synthesis_invalid")).toBe("synthesis_invalid");
    expect(kind("internal_error")).toBe("failed");
    expect(kind("policy_denied")).toBe("policy");
    expect(kind("worker_lost")).toBe("worker_lost");
    expect(kind("runtime_unavailable")).toBe("runtime_unavailable");
    expect(kind("runtime_error")).toBe("failed");
    expect(kind("not_cancelled_really")).toBe("failed");
    expect(kind("over_budget_maybe")).toBe("failed");
  });

  it("formats durations and elapsed time", () => {
    expect(formatDuration(950)).toBe("0.9s");
    expect(formatDuration(61_000)).toBe("1m01s");
    expect(formatDuration(3_725_000)).toBe("1h02m");
    expect(elapsedMs("2026-11-24T10:00:00Z", null, Date.parse("2026-11-24T10:00:05Z"))).toBe(5000);
    expect(
      elapsedMs("2026-11-24T10:00:00Z", "2026-11-24T10:00:02Z", Date.parse("2026-11-24T10:09:00Z")),
    ).toBe(2000);
  });

  it("finds a host in a tool argument summary", () => {
    expect(hostFromSummary("GET https://www.acme.com/a?b")).toBe("acme.com");
    expect(hostFromSummary("acme.com/sitemap.xml")).toBe("acme.com");
    expect(hostFromSummary("query: pricing")).toBeNull();
  });
});
