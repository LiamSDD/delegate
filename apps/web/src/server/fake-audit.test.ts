import { foldRun, parseRunEvent, type RunEvent } from "@delegate/runtime";
import { describe, expect, it } from "vitest";

import { AUDIT_SIMULATED_PLAN, auditScript } from "./fake-audit";
import type { EventDraft } from "./runs";

const RUN = "00000000-0000-4000-8000-000000000009";

function toEvents(drafts: EventDraft[]): RunEvent[] {
  const created: EventDraft = {
    type: "run.created",
    payload: {
      workspaceId: "w",
      missionId: "automation-audit",
      input: { url: "https://acme.test/" },
      actor: { type: "guest", id: "g" },
      budget: { maxTokens: 1, maxMicroUsd: 0 },
    },
  };
  const proposed: EventDraft = {
    type: "plan.proposed",
    payload: { version: 1, steps: AUDIT_SIMULATED_PLAN },
  };
  return [created, proposed, ...drafts].map((draft, index) =>
    parseRunEvent({
      ...draft,
      runId: RUN,
      seq: index + 1,
      at: new Date(1e12 + index * 1000).toISOString(),
    }),
  );
}

describe("simulated audit script", () => {
  it("folds to a completed run with a replan for the proposed plan", () => {
    const state = foldRun(
      toEvents(auditScript(RUN, "https://acme.test/", { decision: "approved" }, false)),
    );
    expect(state.status).toBe("completed");
    expect(state.planRevisions).toHaveLength(1);
    expect(Object.values(state.artifacts).map((artifact) => artifact.kind)).toEqual([
      "automation-audit",
      "next-actions",
    ]);
  });

  it("only runs the steps an operator kept", () => {
    const steps = AUDIT_SIMULATED_PLAN.filter((step) => step.id !== "scan-signals").map((step) => ({
      ...step,
      inputs: step.inputs.filter((input) => input !== "scan-signals"),
    }));
    const state = foldRun(
      toEvents(auditScript(RUN, "https://acme.test/", { decision: "approved", steps }, false)),
    );
    expect(state.status).toBe("completed");
    expect(state.steps.some((step) => step.id === "scan-signals")).toBe(false);
    expect(state.planRevisions.map((revision) => revision.version)).toEqual([2, 3]);
  });
});
