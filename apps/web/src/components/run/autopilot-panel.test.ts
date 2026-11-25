import {
  AUTOPILOT_LIMITS,
  buildAutopilotReport,
  foldRun,
  parseRunEvent,
  type RunEvent,
} from "@delegate/runtime";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { autopilotNodes, autopilotReport, liveStatuses } from "@/lib/runs/autopilot";

import { AutopilotBanner, AutopilotReportPanel, MissionGraph } from "./autopilot-panel";

const PARENT = "00000000-0000-4000-8000-0000000000aa";
const BRIEF = "00000000-0000-4000-8000-000000000001";
const XRAY = "00000000-0000-4000-8000-000000000002";

function log(runId: string, bodies: unknown[]): RunEvent[] {
  return bodies.map((body, index) =>
    parseRunEvent({
      ...(body as Record<string, unknown>),
      runId,
      seq: index + 1,
      at: new Date(1e12 + index * 60_000).toISOString(),
    }),
  );
}

const created = {
  type: "run.created",
  payload: {
    workspaceId: "w",
    missionId: "autopilot",
    input: { goal: "Cut support load at Acme" },
    actor: { type: "guest", id: "g" },
    budget: { maxTokens: 1, maxMicroUsd: 0 },
  },
};

const briefStarted = {
  type: "child.started",
  payload: {
    childRunId: BRIEF,
    nodeId: "brief",
    missionId: "custom-goal",
    label: "Goal brief",
    input: { goal: "Cut support load at Acme" },
    approvals: { plan: "human", sideEffects: "none" },
  },
};
const briefDone = {
  type: "child.completed",
  payload: {
    childRunId: BRIEF,
    nodeId: "brief",
    missionId: "custom-goal",
    outcome: {
      status: "completed",
      summary: "Goal brief for Acme: 3 ranked actions.",
      deliverable: { artifactId: "a1", kind: "goal-brief", title: "Goal brief" },
      metrics: [{ label: "Ranked actions", value: "3" }],
      links: [{ label: "Open the run", href: `/runs/${BRIEF}` }],
      needsHuman: [],
    },
    tokens: 2000,
  },
};
const xrayStarted = {
  type: "child.started",
  payload: {
    childRunId: XRAY,
    nodeId: "company-xray",
    missionId: "company-xray",
    label: "Company X-ray",
    input: { url: "https://acme.example/" },
    from: {
      contract: "goal-brief → track",
      fromRunId: BRIEF,
      artifactId: "a2",
      itemTitle: "Automate first-line support",
    },
    approvals: { plan: "auto", sideEffects: "none" },
  },
};

describe("Autopilot mission graph", () => {
  it("renders launched children with live status, hand-offs and queued steps of the track", () => {
    const events = log(PARENT, [created, briefStarted, briefDone, xrayStarted]);
    const nodes = autopilotNodes(
      foldRun(events),
      liveStatuses({ children: [{ childRunId: XRAY, status: "awaiting_plan_approval" }] }),
    );
    expect(nodes.map((node) => [node.nodeId, node.status])).toEqual([
      ["brief", "completed"],
      ["company-xray", "awaiting_plan_approval"],
      ["audit", "queued"],
      ["build", "queued"],
    ]);
    const html = renderToString(createElement(MissionGraph, { nodes, deciding: false }));
    expect(html).toContain("Mission graph");
    expect(html).toContain("2<!-- --> of <!-- -->4<!-- --> launched");
    expect(html).toContain(`href="/runs/${XRAY}"`);
    expect(html).toContain("Review the plan");
    expect(html).toContain("goal-brief → track: Automate first-line support");
    expect(html).toContain("Plan needs approval");
    expect(html).toContain("Starts when the step before it is done");
    expect(html).toContain("plan auto-approved · read-only");
  });

  it("shows only the brief until the track is chosen", () => {
    const events = log(PARENT, [created, briefStarted]);
    const nodes = autopilotNodes(foldRun(events));
    expect(nodes.map((node) => node.nodeId)).toEqual(["brief"]);
    const html = renderToString(createElement(MissionGraph, { nodes, deciding: true }));
    expect(html).toContain("chosen from the brief");
  });

  it("renders the report with deliverables, what needs a human and usage against the caps", () => {
    const state = foldRun(log(PARENT, [created, briefStarted, briefDone]));
    const report = buildAutopilotReport({
      input: { goal: "Cut support load at Acme" },
      tier: "guest",
      children: state.children,
      finish: {
        kind: "finish",
        status: "stopped",
        track: "company",
        stop: { reason: "quota", message: "Stopped before Company X-ray: quota used up." },
      },
      tokens: 2000,
      elapsedMs: 120_000,
      limits: { ...AUTOPILOT_LIMITS },
      now: new Date(1e12),
    });
    const events = log(PARENT, [
      created,
      briefStarted,
      briefDone,
      {
        type: "artifact.created",
        payload: {
          artifactId: "r1",
          kind: "autopilot-report",
          title: "Autopilot report",
          version: 1,
          content: report,
        },
      },
    ]);
    const parsed = autopilotReport(events);
    expect(parsed?.status).toBe("stopped");
    const html = renderToString(createElement(AutopilotReportPanel, { report: report }));
    expect(html).toContain("Autopilot report");
    expect(html).toContain("Still needs a human");
    expect(html).toContain("Stopped before Company X-ray: quota used up.");
    expect(html).toContain("demo visitor: read-only and patches");
    expect(html).toContain(`href="/runs/${BRIEF}"`);
    expect(html).toContain("not started");
  });

  it("marks a child run as part of its Autopilot run", () => {
    const child = log(BRIEF, [
      {
        type: "run.created",
        payload: {
          ...created.payload,
          missionId: "custom-goal",
          autopilot: { parentRunId: PARENT, nodeId: "brief" },
        },
      },
    ]);
    const html = renderToString(createElement(AutopilotBanner, { events: child }));
    expect(html).toContain("Part of Autopilot run 00000000");
    expect(html).toContain(`href="/runs/${PARENT}"`);
    expect(renderToString(createElement(AutopilotBanner, { events: log(PARENT, [created]) }))).toBe(
      "",
    );
  });
});
