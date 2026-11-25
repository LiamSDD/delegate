import { describe, expect, it } from "vitest";

import {
  EventOrderError,
  RUN_EVENT_TYPES,
  diffPlans,
  foldRun,
  parseRunEvent,
  type PlanStep,
  type RunEvent,
} from "./events";

const runId = "run_1";
const at = "2026-11-24T10:00:00.000Z";

const researchStep: PlanStep = {
  id: "s1",
  role: "researcher",
  objective: "Collect public signals about the company",
  inputs: [],
  capabilities: ["web.fetch"],
  acceptance: ["At least 5 cited sources"],
  budgetShare: 0.5,
};

const analysisStep: PlanStep = {
  id: "s2",
  role: "analyst",
  objective: "Rank automation opportunities",
  inputs: ["s1"],
  capabilities: ["artifact.write"],
  acceptance: ["Top 3 opportunities with evidence"],
  budgetShare: 0.5,
};

const usage = {
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 50,
  cacheWriteTokens: 10,
  costMicroUsd: 0,
  provider: "pollinations",
  model: "openai",
};

const samples: Record<RunEvent["type"], unknown> = {
  "run.created": {
    type: "run.created",
    payload: {
      workspaceId: "ws_1",
      missionId: "xray",
      input: { company: "example.com" },
      actor: { type: "guest", id: "guest_1" },
      budget: { maxTokens: 200000, maxMicroUsd: 0 },
    },
  },
  "plan.proposed": { type: "plan.proposed", payload: { version: 1, steps: [researchStep] } },
  "plan.approved": {
    type: "plan.approved",
    payload: { version: 1, approvedBy: { type: "member", id: "m_1" } },
  },
  "plan.revised": {
    type: "plan.revised",
    payload: { version: 2, steps: [researchStep, analysisStep], reason: "New information" },
  },
  "step.started": { type: "step.started", stepId: "s1", payload: {} },
  "agent.spawned": {
    type: "agent.spawned",
    stepId: "s1",
    agentId: "a_1",
    payload: { role: "researcher", modelRole: "worker" },
  },
  "agent.message": {
    type: "agent.message",
    stepId: "s1",
    agentId: "a_1",
    payload: { text: "Fetching the sitemap" },
  },
  "tool.called": {
    type: "tool.called",
    stepId: "s1",
    agentId: "a_1",
    payload: {
      toolCallId: "tc_1",
      tool: "web_fetch",
      capability: "web.fetch",
      argsSummary: "GET https://example.com/sitemap.xml",
    },
  },
  "tool.result": {
    type: "tool.result",
    stepId: "s1",
    agentId: "a_1",
    payload: {
      toolCallId: "tc_1",
      tool: "web_fetch",
      ok: true,
      summary: "42 URLs",
      durationMs: 310,
    },
  },
  "policy.decided": {
    type: "policy.decided",
    stepId: "s1",
    payload: {
      toolCallId: "tc_1",
      tool: "web_fetch",
      decision: "allow",
      policyId: "guest-demo",
      reason: "No rule denied",
    },
  },
  "artifact.created": {
    type: "artifact.created",
    stepId: "s1",
    payload: { artifactId: "art_1", kind: "report", title: "X-ray", version: 1 },
  },
  "artifact.updated": {
    type: "artifact.updated",
    stepId: "s1",
    payload: { artifactId: "art_1", version: 2 },
  },
  "critic.flagged": {
    type: "critic.flagged",
    stepId: "s1",
    payload: {
      claimId: "c_1",
      claim: "Founded in 1999",
      reason: "Cited passage does not mention a year",
      severity: "warn",
    },
  },
  "approval.requested": {
    type: "approval.requested",
    stepId: "s1",
    payload: {
      approvalId: "ap_1",
      policyId: "guest-demo",
      reason: "Side effect",
      summary: "Open a PR",
    },
  },
  "approval.resolved": {
    type: "approval.resolved",
    stepId: "s1",
    payload: {
      approvalId: "ap_1",
      resolution: "approved",
      resolvedBy: { type: "member", id: "m_1" },
    },
  },
  "usage.updated": { type: "usage.updated", stepId: "s1", payload: usage },
  "step.completed": {
    type: "step.completed",
    stepId: "s1",
    payload: { outcome: "succeeded", summary: "Done", confidence: 0.8, artifactIds: ["art_1"] },
  },
  "run.completed": { type: "run.completed", payload: { summary: "Delivered" } },
  "run.failed": {
    type: "run.failed",
    payload: { error: { code: "budget_exceeded", message: "Run budget exhausted" } },
  },
  "model.fallback": {
    type: "model.fallback",
    stepId: "s1",
    payload: {
      role: "worker",
      from: { provider: "pollinations", model: "openai" },
      to: { provider: "llm7", model: "gpt-oss-120b" },
      reason: "rate_limited",
      retryAfterMs: 15000,
    },
  },
  "connector.call": {
    type: "connector.call",
    stepId: "s1",
    payload: {
      toolCallId: "tc_1",
      connectorId: "c_1",
      server: "tickets",
      tool: "search_issues",
      ok: true,
      durationMs: 120,
      bytes: 2048,
      truncated: false,
      summary: "3 results",
    },
  },
};

function envelope(seq: number, body: unknown): unknown {
  return { runId, seq, at, ...(body as Record<string, unknown>) };
}

function build(bodies: unknown[]): RunEvent[] {
  return bodies.map((body, index) => parseRunEvent(envelope(index + 1, body)));
}

describe("RunEvent", () => {
  it("lists exactly the twenty event types", () => {
    expect(RUN_EVENT_TYPES).toHaveLength(20);
    expect(new Set(RUN_EVENT_TYPES).size).toBe(20);
    expect(Object.keys(samples).sort()).toEqual([...RUN_EVENT_TYPES].sort());
  });

  it.each(RUN_EVENT_TYPES)("round-trips %s through JSON", (type) => {
    const parsed = parseRunEvent(envelope(7, samples[type]));
    expect(parsed.type).toBe(type);
    const reparsed = parseRunEvent(JSON.parse(JSON.stringify(parsed)));
    expect(reparsed).toEqual(parsed);
  });

  it("rejects an invalid payload", () => {
    expect(() =>
      parseRunEvent(
        envelope(1, {
          type: "usage.updated",
          stepId: "s1",
          payload: { ...usage, inputTokens: -1 },
        }),
      ),
    ).toThrow();
    expect(() =>
      parseRunEvent(
        envelope(1, {
          type: "policy.decided",
          payload: { tool: "x", decision: "maybe", policyId: "p", reason: "r" },
        }),
      ),
    ).toThrow();
  });

  it("rejects fractional money, unknown types and bad timestamps", () => {
    expect(() =>
      parseRunEvent(
        envelope(1, {
          type: "usage.updated",
          stepId: "s1",
          payload: { ...usage, costMicroUsd: 1.5 },
        }),
      ),
    ).toThrow();
    expect(() => parseRunEvent(envelope(1, { type: "run.paused", payload: {} }))).toThrow();
    expect(() =>
      parseRunEvent({ ...(envelope(1, samples["run.completed"]) as object), at: "yesterday" }),
    ).toThrow();
  });

  it("requires stepId on step-scoped events", () => {
    expect(() => parseRunEvent(envelope(1, { type: "step.started", payload: {} }))).toThrow();
  });
});

describe("diffPlans", () => {
  it("reports added, removed and changed steps", () => {
    const changed = { ...researchStep, objective: "Collect public and hiring signals" };
    const third: PlanStep = { ...analysisStep, id: "s3" };
    expect(diffPlans([researchStep, analysisStep], [changed, third])).toEqual({
      added: ["s3"],
      removed: ["s2"],
      changed: ["s1"],
    });
  });
});

describe("foldRun", () => {
  it("derives the run state from a realistic event sequence", () => {
    const events = build([
      samples["run.created"],
      { type: "plan.proposed", payload: { version: 1, steps: [researchStep, analysisStep] } },
      samples["plan.approved"],
      samples["step.started"],
      samples["agent.spawned"],
      samples["model.fallback"],
      samples["tool.called"],
      samples["policy.decided"],
      samples["tool.result"],
      samples["usage.updated"],
      samples["artifact.created"],
      samples["approval.requested"],
      samples["usage.updated"],
      samples["artifact.updated"],
      samples["step.completed"],
      { type: "step.started", stepId: "s2", payload: {} },
      {
        type: "policy.decided",
        stepId: "s2",
        payload: {
          tool: "send_email",
          decision: "deny",
          policyId: "guest-demo",
          reason: "Not granted",
        },
      },
      {
        type: "step.completed",
        stepId: "s2",
        payload: { outcome: "failed", summary: "Denied", artifactIds: [] },
      },
    ]);

    const state = foldRun(events);

    expect(state.runId).toBe(runId);
    expect(state.status).toBe("awaiting_approval");
    expect(state.workspaceId).toBe("ws_1");
    expect(state.missionId).toBe("xray");
    expect(state.plan?.version).toBe(1);
    expect(state.plan?.approved).toBe(true);
    expect(state.steps.map((step) => [step.id, step.status])).toEqual([
      ["s1", "succeeded"],
      ["s2", "failed"],
    ]);
    expect(state.steps[0]?.servedBy).toEqual({ provider: "pollinations", model: "openai" });
    expect(state.totals).toEqual({
      inputTokens: 2000,
      outputTokens: 400,
      cacheReadTokens: 100,
      cacheWriteTokens: 20,
      costMicroUsd: 0,
      toolCalls: 1,
      policyDenials: 1,
    });
    expect(state.pendingApprovals.map((approval) => approval.approvalId)).toEqual(["ap_1"]);
    expect(state.artifacts).toEqual({
      art_1: { artifactId: "art_1", kind: "report", title: "X-ray", version: 2, stepId: "s1" },
    });
    expect(state.fallbacks).toHaveLength(1);
    expect(state.fallbacks[0]?.reason).toBe("rate_limited");
    expect(state.lastSeq).toBe(18);

    const resolved = foldRun([
      ...events,
      parseRunEvent(envelope(19, samples["approval.resolved"])),
      parseRunEvent(envelope(20, samples["run.completed"])),
    ]);
    expect(resolved.pendingApprovals).toEqual([]);
    expect(resolved.status).toBe("completed");
    expect(resolved.summary).toBe("Delivered");
  });

  it("moves through planning states", () => {
    const created = build([samples["run.created"]]);
    expect(foldRun(created).status).toBe("planning");
    const proposed = build([samples["run.created"], samples["plan.proposed"]]);
    expect(foldRun(proposed).status).toBe("awaiting_plan_approval");
    const approved = build([
      samples["run.created"],
      samples["plan.proposed"],
      samples["plan.approved"],
    ]);
    expect(foldRun(approved).status).toBe("running");
  });

  it("replaces steps on plan.revised and records the diff", () => {
    const changedResearch = { ...researchStep, objective: "Collect public and hiring signals" };
    const reviewStep: PlanStep = {
      id: "s3",
      role: "critic",
      objective: "Check every claim",
      inputs: ["s1"],
      capabilities: [],
      acceptance: ["Citation accuracy >= 95%"],
      budgetShare: 0.2,
    };
    const state = foldRun(
      build([
        samples["run.created"],
        { type: "plan.proposed", payload: { version: 1, steps: [researchStep, analysisStep] } },
        samples["plan.approved"],
        samples["step.started"],
        {
          type: "plan.revised",
          payload: {
            version: 2,
            steps: [changedResearch, reviewStep],
            reason: "Analyst step not needed",
          },
        },
      ]),
    );

    expect(state.plan?.version).toBe(2);
    expect(state.plan?.steps).toEqual([changedResearch, reviewStep]);
    expect(state.steps.map((step) => [step.id, step.status])).toEqual([
      ["s1", "running"],
      ["s3", "pending"],
    ]);
    expect(state.planRevisions).toEqual([
      {
        version: 2,
        reason: "Analyst step not needed",
        diff: { added: ["s3"], removed: ["s2"], changed: ["s1"] },
        seq: 5,
      },
    ]);
  });

  it("marks failed runs and keeps the error", () => {
    const state = foldRun(build([samples["run.created"], samples["run.failed"]]));
    expect(state.status).toBe("failed");
    expect(state.error).toEqual({ code: "budget_exceeded", message: "Run budget exhausted" });
  });

  it("rejects events out of order or from another run", () => {
    const [first, second] = build([samples["run.created"], samples["plan.proposed"]]);
    if (!first || !second) throw new Error("fixture");
    expect(() => foldRun([second, first])).toThrow(EventOrderError);
    expect(() => foldRun([first, { ...second, runId: "run_2" }])).toThrow(EventOrderError);
    expect(() => foldRun([])).toThrow(EventOrderError);
  });
});

describe("plan schema invariants", () => {
  const proposed = (steps: unknown[]) =>
    envelope(2, { type: "plan.proposed", payload: { version: 1, steps } });

  it("rejects duplicate step ids", () => {
    expect(() => parseRunEvent(proposed([researchStep, { ...analysisStep, id: "s1" }]))).toThrow(
      /Duplicate step id s1/,
    );
  });

  it("rejects inputs that reference unknown steps", () => {
    expect(() => parseRunEvent(proposed([{ ...analysisStep, inputs: ["s9"] }]))).toThrow(
      /unknown step s9/,
    );
  });

  it("rejects budget shares that sum above 1", () => {
    expect(() =>
      parseRunEvent(proposed([researchStep, { ...analysisStep, budgetShare: 0.6 }])),
    ).toThrow(/budgetShare/);
    expect(() =>
      parseRunEvent(
        proposed([
          { ...researchStep, budgetShare: 0.1 },
          { ...analysisStep, budgetShare: 0.2 },
          { ...analysisStep, id: "s3", budgetShare: 0.7 },
        ]),
      ),
    ).not.toThrow();
  });

  it("applies the same invariants to plan.revised", () => {
    expect(() =>
      parseRunEvent(
        envelope(3, {
          type: "plan.revised",
          payload: { version: 2, steps: [researchStep, researchStep], reason: "dup" },
        }),
      ),
    ).toThrow(/Duplicate step id/);
  });
});

describe("usage events", () => {
  it("accepts an estimated flag for providers that omit usage", () => {
    const parsed = parseRunEvent(
      envelope(1, { type: "usage.updated", stepId: "s1", payload: { ...usage, estimated: true } }),
    );
    expect(parsed.type === "usage.updated" && parsed.payload.estimated).toBe(true);
  });
});

describe("foldRun ordering rules", () => {
  it("requires run.created first", () => {
    expect(() => foldRun(build([samples["plan.proposed"]]))).toThrow(/run.created/);
    expect(() => foldRun(build([samples["run.created"], samples["run.created"]]))).toThrow(
      EventOrderError,
    );
  });

  it("rejects events after a terminal state", () => {
    expect(() =>
      foldRun(build([samples["run.created"], samples["run.completed"], samples["plan.proposed"]])),
    ).toThrow(/terminal/);
    expect(() =>
      foldRun(build([samples["run.created"], samples["run.failed"], samples["run.completed"]])),
    ).toThrow(EventOrderError);
  });

  it("rejects plan approval for a version that is not the current plan", () => {
    expect(() =>
      foldRun(
        build([
          samples["run.created"],
          samples["plan.proposed"],
          {
            type: "plan.approved",
            payload: { version: 2, approvedBy: { type: "member", id: "m_1" } },
          },
        ]),
      ),
    ).toThrow(/version 2/);
    expect(() => foldRun(build([samples["run.created"], samples["plan.approved"]]))).toThrow(
      EventOrderError,
    );
  });

  it("rejects step events for steps that are not in the plan", () => {
    expect(() => foldRun(build([samples["run.created"], samples["step.started"]]))).toThrow(
      /unknown step s1/,
    );
    expect(() =>
      foldRun(
        build([
          samples["run.created"],
          samples["plan.proposed"],
          samples["plan.approved"],
          {
            type: "step.completed",
            stepId: "s9",
            payload: { outcome: "succeeded", summary: "x", artifactIds: [] },
          },
        ]),
      ),
    ).toThrow(/unknown step s9/);
  });

  it("stores artifacts without prototype pollution", () => {
    const state = foldRun(
      build([
        samples["run.created"],
        samples["plan.proposed"],
        samples["plan.approved"],
        {
          type: "artifact.created",
          payload: { artifactId: "__proto__", kind: "report", title: "Proto", version: 1 },
        },
        { type: "artifact.updated", payload: { artifactId: "constructor", version: 2 } },
      ]),
    );
    expect(Object.keys(state.artifacts)).toEqual(["__proto__"]);
    expect(state.artifacts.__proto__).toMatchObject({ title: "Proto" });
    expect(Object.prototype.hasOwnProperty.call(state.artifacts, "constructor")).toBe(false);
    expect(({} as Record<string, unknown>).title).toBeUndefined();
  });
});

describe("M1 payload extensions", () => {
  it("keeps artifact content snapshots on created and updated events", () => {
    const created = parseRunEvent(
      envelope(1, {
        type: "artifact.created",
        payload: { artifactId: "a1", kind: "brief", title: "Brief", version: 1, content: { x: 1 } },
      }),
    );
    expect(created.type === "artifact.created" && created.payload.content).toEqual({ x: 1 });
    const updated = parseRunEvent(
      envelope(2, {
        type: "artifact.updated",
        payload: { artifactId: "a1", version: 2, content: { x: 2 } },
      }),
    );
    expect(updated.type === "artifact.updated" && updated.payload.content).toEqual({ x: 2 });
  });

  it("categorises critic flags, including suspected prompt injection", () => {
    const flagged = parseRunEvent(
      envelope(1, {
        type: "critic.flagged",
        payload: {
          claimId: "injection:S2",
          claim: "Ignore previous instructions",
          reason: "Possible prompt injection",
          severity: "warn",
          sourceId: "S2",
          category: "injection_suspected",
        },
      }),
    );
    expect(flagged.type === "critic.flagged" && flagged.payload.category).toBe(
      "injection_suspected",
    );
    expect(() =>
      parseRunEvent(
        envelope(1, {
          type: "critic.flagged",
          payload: { claimId: "c", claim: "c", reason: "r", severity: "warn", category: "vibes" },
        }),
      ),
    ).toThrow();
  });

  it("records why a plan was approved", () => {
    const approved = parseRunEvent(
      envelope(1, {
        type: "plan.approved",
        payload: {
          version: 1,
          approvedBy: { type: "system", id: "m1-auto-approve" },
          reason: "Auto-approved by the system: plan approval UI arrives in M2",
        },
      }),
    );
    expect(approved.type === "plan.approved" && approved.payload.reason).toMatch(/M2/);
  });
});
