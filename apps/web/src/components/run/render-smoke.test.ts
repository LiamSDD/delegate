import { parseRunEvent, type RunEvent } from "@delegate/runtime";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { buildRunView } from "@/lib/runs/run-view";
import { AUDIT_SIMULATED_PLAN, auditScript } from "@/server/fake-audit";
import type { EventDraft } from "@/server/runs";

import { AgentLanes } from "./agent-lanes";
import { AuditPanel } from "./audit-panel";
import { PlanApprovalCard } from "./plan-approval-card";
import { PlanPanel } from "./plan-panel";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }));

const RUN = "00000000-0000-4000-8000-00000000000a";

function events(drafts: EventDraft[]): RunEvent[] {
  return drafts.map((draft, index) =>
    parseRunEvent({
      ...draft,
      runId: RUN,
      seq: index + 1,
      at: new Date(1e12 + index * 700).toISOString(),
    }),
  );
}

const log = events([
  {
    type: "run.created",
    payload: {
      workspaceId: "w",
      missionId: "automation-audit",
      input: { url: "https://acme.test/" },
      actor: { type: "guest", id: "g" },
      budget: { maxTokens: 1, maxMicroUsd: 0 },
    },
  },
  { type: "plan.proposed", payload: { version: 1, steps: AUDIT_SIMULATED_PLAN } },
  ...auditScript(RUN, "https://acme.test/", { decision: "approved" }, false),
]);

describe("M2 run view panels render from a simulated audit", () => {
  it("renders the audit, lanes, plan diff and approval card", () => {
    const view = buildRunView(log);
    if (!view.ok) throw new Error(view.error);
    expect(view.citation).toEqual({ kind: "reported", value: 0.875, checked: 16 });
    const now = Date.parse(log.at(-1)?.at ?? "");
    const audit = renderToString(
      createElement(AuditPanel, {
        artifact: view.audit,
        target: "acme.test",
        running: false,
        runId: RUN,
        buildActions: view.nextActions.map((action) => ({ ...action, available: true })),
      }),
    );
    expect(audit).toContain("Support ticket triage");
    expect(audit).toContain("estimate");
    expect(audit).toContain("Build it");
    expect(audit).not.toContain("Not buildable");
    const simulated = renderToString(
      createElement(AuditPanel, {
        artifact: view.audit,
        target: "acme.test",
        running: false,
        runId: RUN,
        buildActions: view.nextActions,
      }),
    );
    expect(simulated).toContain("Not buildable from this audit");
    const lanes = renderToString(
      createElement(AgentLanes, { lanes: view.lanes, liveFromSeq: null, waiting: false, now }),
    );
    expect(lanes.replace(/<!-- -->/g, "")).toContain("6 lanes");
    const plan = renderToString(
      createElement(PlanPanel, {
        versions: view.planVersions,
        steps: view.steps,
        now,
        waiting: false,
        approval: view.planApproval,
      }),
    );
    expect(plan).toContain("added");
    const card = renderToString(
      createElement(PlanApprovalCard, { runId: RUN, version: 1, steps: AUDIT_SIMULATED_PLAN }),
    );
    expect(card).toContain("Approve plan");
  });
});
