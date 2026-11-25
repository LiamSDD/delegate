import { describe, expect, it } from "vitest";

import { type ChildRunState, type RunEvent } from "../../events";
import {
  assistantFixture,
  auditFixture,
  childLog,
  goalBriefFixture,
  nextActionsFixture,
  repoXrayFixture,
  shipResultFixture,
} from "../../testing/autopilot";
import { BuildAgentInputSchema } from "../build-agent/input";
import { ShipAPrInputSchema } from "../ship-a-pr/input";
import {
  buildInputFromAudit,
  childArtifacts,
  chooseTrack,
  CONTRACTS,
  shipInputFromXray,
} from "./chain";
import { summariseChild } from "./outcome";
import { buildAutopilotReport, nextAutopilotMove, type AutopilotProgress } from "./plan";
import { autopilotChildPolicy } from "./policy";
import { AUTOPILOT_LIMITS, AutopilotReportSchema } from "./schema";

const BRIEF_RUN = "00000000-0000-4000-8000-000000000001";
const XRAY_RUN = "00000000-0000-4000-8000-000000000002";
const AUDIT_RUN = "00000000-0000-4000-8000-000000000003";
const BUILD_RUN = "00000000-0000-4000-8000-000000000004";

function artifactsOf(events: RunEvent[]) {
  return childArtifacts(events);
}

const acme = { name: "Acme", url: "https://acme.example/" };

function briefLog(actions = nextActionsFixture([])) {
  return childLog(
    BRIEF_RUN,
    "custom-goal",
    [
      { kind: "goal-brief", title: "Goal brief", content: goalBriefFixture(acme) },
      { kind: "next-actions", title: "Next actions", content: actions },
    ],
    { status: "completed", summary: "Goal brief for Acme: 1 ranked action." },
  );
}

function child(
  nodeId: string,
  missionId: ChildRunState["missionId"],
  childRunId: string,
  input: Record<string, unknown>,
  events: RunEvent[],
): ChildRunState {
  return {
    nodeId,
    missionId,
    childRunId,
    label: nodeId,
    input,
    approvals: { plan: "auto", sideEffects: "none" },
    seq: 1,
    startedAt: "2026-11-25T10:00:00.000Z",
    outcome: summariseChild(missionId, childRunId, events),
    tokens: 1000,
  };
}

function progress(
  children: ChildRunState[],
  logs: Record<string, RunEvent[]>,
  overrides: Partial<AutopilotProgress> = {},
): AutopilotProgress {
  return {
    input: { goal: "Cut support load at acme.example" },
    children,
    artifacts: (runId) => {
      const log = logs[runId];
      return log === undefined ? undefined : artifactsOf(log);
    },
    tokens: 0,
    elapsedMs: 0,
    limits: { ...AUTOPILOT_LIMITS },
    shipAvailable: true,
    ...overrides,
  };
}

describe("chaining contracts", () => {
  it("turns the top audit opportunity that survived verification into a Build-an-Agent input", () => {
    const log = childLog(
      AUDIT_RUN,
      "automation-audit",
      [{ kind: "automation-audit", title: "Audit", content: auditFixture() }],
      { status: "completed", summary: "Audit done." },
    );
    const result = buildInputFromAudit(AUDIT_RUN, { url: acme.url }, artifactsOf(log));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(BuildAgentInputSchema.parse(result.handoff.input)).toEqual({
      url: acme.url,
      goal: "An assistant that handles return requests from the help centre",
      name: "Return requests",
      opportunityId: "opp-2",
      fromAuditRunId: AUDIT_RUN,
    });
    expect(result.handoff.from).toMatchObject({
      contract: CONTRACTS.auditBuild,
      fromRunId: AUDIT_RUN,
      itemId: "opp-2",
    });
  });

  it("refuses a hand-off from an audit whose deliverable does not validate", () => {
    const log = childLog(
      AUDIT_RUN,
      "automation-audit",
      [{ kind: "automation-audit", title: "Audit", content: { opportunities: [] } }],
      { status: "completed", summary: "Audit done." },
    );
    const result = buildInputFromAudit(AUDIT_RUN, { url: acme.url }, artifactsOf(log));
    expect(result).toMatchObject({ ok: false });
    expect(buildInputFromAudit(AUDIT_RUN, { url: acme.url }, new Map())).toMatchObject({
      ok: false,
      message: expect.stringContaining("published no opportunities") as unknown,
    });
  });

  it("turns the best verified small improvement into a Ship-a-PR input", () => {
    const log = childLog(
      XRAY_RUN,
      "repo-xray",
      [{ kind: "repo-xray", title: "X-ray", content: repoXrayFixture() }],
      { status: "completed", summary: "X-ray done." },
    );
    const result = shipInputFromXray(XRAY_RUN, artifactsOf(log));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const input = ShipAPrInputSchema.parse(result.handoff.input);
    expect(input.repoUrl).toBe("https://github.com/acme/widget");
    expect(input.ref).toBe("main");
    expect(input.improvement.id).toBe("imp-small");
    expect(input.improvement).not.toHaveProperty("citations");
    expect(result.handoff.from?.contract).toBe(CONTRACTS.improvementShip);
  });

  it("picks the track from the brief's first launchable next action", () => {
    const repo = chooseTrack(
      BRIEF_RUN,
      artifactsOf(
        briefLog(
          nextActionsFixture([
            {
              id: "ship-via-repo-xray",
              label: "Ship a PR: X-ray the repository first",
              missionId: "repo-xray",
              input: { url: "https://github.com/acme/widget" },
              available: true,
            },
            {
              id: "run-automation-audit",
              label: "Run AI Automation Audit",
              missionId: "automation-audit",
              input: { url: acme.url },
              available: true,
            },
          ]),
        ),
      ),
    );
    expect(repo).toMatchObject({
      ok: true,
      track: "repo",
      handoff: { input: { url: "https://github.com/acme/widget" } },
    });
    const company = chooseTrack(BRIEF_RUN, artifactsOf(briefLog()));
    expect(company).toMatchObject({
      ok: true,
      track: "company",
      handoff: { input: { url: acme.url } },
    });
  });

  it("finishes with the brief alone when there is nothing to act on, and fails on an incomplete brief", () => {
    const lonely = childLog(
      BRIEF_RUN,
      "custom-goal",
      [{ kind: "goal-brief", title: "Goal brief", content: goalBriefFixture(null) }],
      { status: "completed", summary: "Brief." },
    );
    expect(chooseTrack(BRIEF_RUN, artifactsOf(lonely))).toMatchObject({
      ok: true,
      track: "brief-only",
    });
    const draft = childLog(
      BRIEF_RUN,
      "custom-goal",
      [{ kind: "goal-brief", title: "Goal brief", content: { status: "draft" } }],
      { status: "completed", summary: "Brief." },
    );
    expect(chooseTrack(BRIEF_RUN, artifactsOf(draft))).toMatchObject({ ok: false });
  });
});

describe("nextAutopilotMove", () => {
  const brief = briefLog();
  const xray = childLog(
    XRAY_RUN,
    "company-xray",
    [{ kind: "company-xray-brief", title: "X-ray", content: { company: acme, sources: [] } }],
    { status: "completed", summary: "X-ray for Acme." },
  );
  const audit = childLog(
    AUDIT_RUN,
    "automation-audit",
    [{ kind: "automation-audit", title: "Audit", content: auditFixture() }],
    { status: "completed", summary: "Audit for Acme." },
  );
  const logs = { [BRIEF_RUN]: brief, [XRAY_RUN]: xray, [AUDIT_RUN]: audit };
  const briefChild = child("brief", "custom-goal", BRIEF_RUN, { goal: "g" }, brief);
  const xrayChild = child("company-xray", "company-xray", XRAY_RUN, { url: acme.url }, xray);
  const auditChild = child("audit", "automation-audit", AUDIT_RUN, { url: acme.url }, audit);

  it("walks brief → X-ray → audit → build, passing structured outputs along", () => {
    expect(nextAutopilotMove(progress([], logs))).toMatchObject({
      kind: "start",
      node: { nodeId: "brief" },
      input: { goal: "Cut support load at acme.example" },
    });
    expect(nextAutopilotMove(progress([briefChild], logs))).toMatchObject({
      kind: "start",
      node: { nodeId: "company-xray" },
      track: "company",
    });
    expect(nextAutopilotMove(progress([briefChild, xrayChild], logs))).toMatchObject({
      kind: "start",
      node: { nodeId: "audit" },
      input: { url: acme.url, focus: "Reduce repetitive support tickets at Acme" },
    });
    expect(nextAutopilotMove(progress([briefChild, xrayChild, auditChild], logs))).toMatchObject({
      kind: "start",
      node: { nodeId: "build", missionId: "build-agent" },
      input: { opportunityId: "opp-2", fromAuditRunId: AUDIT_RUN },
      from: { contract: CONTRACTS.auditBuild },
    });
    const build = childLog(
      BUILD_RUN,
      "build-agent",
      [{ kind: "assistant", title: "Assistant", content: assistantFixture() }],
      { status: "completed", summary: "Assistant ready." },
    );
    const buildChild = child("build", "build-agent", BUILD_RUN, {}, build);
    expect(
      nextAutopilotMove(
        progress([briefChild, xrayChild, auditChild, buildChild], logs, {
          limits: { ...AUTOPILOT_LIMITS, maxChildren: 10 },
        }),
      ),
    ).toMatchObject({ kind: "finish", status: "completed", stop: null });
  });

  it("stops on the first failure with the child's error", () => {
    const failed = childLog(XRAY_RUN, "company-xray", [], {
      status: "failed",
      message: "The site refused every fetch.",
    });
    const move = nextAutopilotMove(
      progress([briefChild, child("company-xray", "company-xray", XRAY_RUN, {}, failed)], logs),
    );
    expect(move).toMatchObject({
      kind: "finish",
      status: "failed",
      stop: {
        reason: "child_failed",
        message: expect.stringContaining("refused every fetch") as unknown,
      },
    });
  });

  it("enforces the child count, token and wall-time caps before starting anything", () => {
    expect(
      nextAutopilotMove(
        progress([briefChild, xrayChild], logs, {
          limits: { ...AUTOPILOT_LIMITS, maxChildren: 2 },
        }),
      ),
    ).toMatchObject({ kind: "finish", status: "stopped", stop: { reason: "max_children" } });
    expect(
      nextAutopilotMove(progress([briefChild], logs, { tokens: AUTOPILOT_LIMITS.maxTokens })),
    ).toMatchObject({ kind: "finish", stop: { reason: "token_cap" } });
    expect(
      nextAutopilotMove(progress([briefChild], logs, { elapsedMs: AUTOPILOT_LIMITS.maxWallMs })),
    ).toMatchObject({ kind: "finish", stop: { reason: "wall_time" } });
  });

  it("does not start Ship-a-PR where the deployment cannot run it", () => {
    const repoXray = childLog(
      XRAY_RUN,
      "repo-xray",
      [{ kind: "repo-xray", title: "X-ray", content: repoXrayFixture() }],
      { status: "completed", summary: "X-ray." },
    );
    const children = [
      briefChild,
      child(
        "repo-xray",
        "repo-xray",
        XRAY_RUN,
        { url: "https://github.com/acme/widget" },
        repoXray,
      ),
    ];
    const repoLogs = { ...logs, [XRAY_RUN]: repoXray };
    expect(nextAutopilotMove(progress(children, repoLogs))).toMatchObject({
      kind: "start",
      node: { nodeId: "ship" },
      input: { repoUrl: "https://github.com/acme/widget" },
    });
    expect(nextAutopilotMove(progress(children, repoLogs, { shipAvailable: false }))).toMatchObject(
      {
        kind: "finish",
        status: "stopped",
        stop: { reason: "unavailable" },
      },
    );
  });
});

describe("autopilotChildPolicy", () => {
  it("gives demo visitors read-only children and patches only", () => {
    expect(autopilotChildPolicy("guest", "ship-a-pr", true)).toEqual({
      approvals: { plan: "auto", sideEffects: "patch_only" },
      connectors: false,
      githubInstallation: false,
      fixedPlan: true,
    });
    expect(autopilotChildPolicy("guest", "custom-goal", true)).toMatchObject({
      approvals: { sideEffects: "none" },
      connectors: false,
    });
  });

  it("lets connected workspaces reach side effects that still ask, and follows the plan setting", () => {
    expect(autopilotChildPolicy("connected", "ship-a-pr", false)).toMatchObject({
      approvals: { plan: "auto", sideEffects: "ask" },
      githubInstallation: true,
    });
    expect(autopilotChildPolicy("connected", "custom-goal", false)).toMatchObject({
      approvals: { plan: "human", sideEffects: "ask" },
      connectors: true,
    });
    expect(autopilotChildPolicy("connected", "automation-audit", true)).toMatchObject({
      approvals: { plan: "auto", sideEffects: "none" },
      connectors: false,
      githubInstallation: false,
    });
  });
});

describe("summariseChild and the report", () => {
  it("summarises outcomes with honest metrics and what needs a human", () => {
    const build = summariseChild(
      "build-agent",
      BUILD_RUN,
      childLog(
        BUILD_RUN,
        "build-agent",
        [{ kind: "assistant", title: "A", content: assistantFixture() }],
        {
          status: "completed",
          summary: "Assistant ready.",
        },
      ),
    );
    expect(build.metrics).toContainEqual({ label: "Self-test", value: "80%" });
    expect(build.links.map((link) => link.href)).toEqual([
      `/runs/${BUILD_RUN}`,
      "/agents/6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b",
    ]);
    expect(build.needsHuman[0]).toContain("2 gaps");
    const opened = summariseChild(
      "ship-a-pr",
      BUILD_RUN,
      childLog(
        BUILD_RUN,
        "ship-a-pr",
        [{ kind: "ship-result", title: "S", content: shipResultFixture("opened") }],
        {
          status: "completed",
          summary: "PR opened.",
        },
      ),
    );
    expect(opened.links).toContainEqual({
      label: "PR #7",
      href: "https://github.com/acme/widget/pull/7",
    });
    const patch = summariseChild(
      "ship-a-pr",
      BUILD_RUN,
      childLog(
        BUILD_RUN,
        "ship-a-pr",
        [{ kind: "ship-result", title: "S", content: shipResultFixture("patch_ready") }],
        {
          status: "completed",
          summary: "Patch ready.",
        },
      ),
    );
    expect(patch.needsHuman[0]).toContain("Apply the patch");
  });

  it("builds a report with not-started steps and the stop reason", () => {
    const brief = briefLog();
    const briefChild = child("brief", "custom-goal", BRIEF_RUN, { goal: "g" }, brief);
    const report = buildAutopilotReport({
      input: { goal: "Cut support load" },
      tier: "guest",
      children: [briefChild],
      finish: {
        kind: "finish",
        status: "stopped",
        track: "company",
        stop: { reason: "token_cap", message: "Stopped: token cap." },
      },
      tokens: 1000,
      elapsedMs: 5000,
      limits: { ...AUTOPILOT_LIMITS },
      now: new Date("2026-11-25T10:00:00.000Z"),
    });
    expect(AutopilotReportSchema.parse(report)).toEqual(report);
    expect(report.steps.map((step) => [step.nodeId, step.status])).toEqual([
      ["brief", "completed"],
      ["company-xray", "not_started"],
      ["audit", "not_started"],
      ["build", "not_started"],
    ]);
    expect(report.needsHuman).toContain("Stopped: token cap.");
    expect(report.headline).toMatch(/^1 of 4 steps done/);
  });
});
