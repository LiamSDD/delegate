import type { PlanStep } from "@delegate/runtime";

import type { ActiveRun, RunSnapshot } from "@/server/control/active-runs";
import type { InboxItem } from "@/server/control/inbox";
import { emptyMissionControl, type MissionControl } from "@/server/control/overview";

export const FIXTURE_NOW = new Date("2026-11-25T12:00:00.000Z");

const LONG_HOST =
  "a-very-long-subdomain-name.for-a-customer-portal.internal-tools.example-corporation.com";
const SHA = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

function minutesAgo(minutes: number): Date {
  return new Date(FIXTURE_NOW.getTime() - minutes * 60_000);
}

function snapshot(overrides: Partial<RunSnapshot> & Pick<RunSnapshot, "id">): RunSnapshot {
  return {
    mission: "company-xray",
    target: "acme.example",
    execution: "live",
    status: "running",
    createdAt: minutesAgo(4),
    finishedAt: null,
    lastEventAt: minutesAgo(0.2),
    tokens: 18_420,
    step: { id: "research-products", state: "running" },
    stalled: false,
    ...overrides,
  };
}

export const planSteps: PlanStep[] = [
  {
    id: "map-site",
    role: "researcher",
    objective: "Map the public site and list the product pages worth reading.",
    inputs: [],
    capabilities: ["web.fetch"],
    acceptance: ["At least five product pages listed"],
    budgetShare: 0.4,
  },
  {
    id: "draft-audit",
    role: "analyst",
    objective: "Draft the automation audit from the mapped pages, with a citation per claim.",
    inputs: ["map-site"],
    capabilities: ["artifact.write", "scratchpad.write"],
    acceptance: ["Every opportunity cites a page"],
    budgetShare: 0.6,
  },
];

const activeRuns: ActiveRun[] = [
  {
    ...snapshot({
      id: "11111111-1111-4111-8111-111111111111",
      mission: "autopilot",
      target: LONG_HOST,
      step: null,
      tokens: 0,
    }),
    children: [
      snapshot({
        id: "22222222-2222-4222-8222-222222222222",
        status: "completed",
        finishedAt: minutesAgo(2),
        step: { id: "write-brief", state: "finished" },
      }),
      snapshot({
        id: "33333333-3333-4333-8333-333333333333",
        mission: "automation-audit",
        status: "awaiting_plan_approval",
        step: null,
        tokens: 2_310,
      }),
    ],
  },
  {
    ...snapshot({
      id: "44444444-4444-4444-8444-444444444444",
      mission: "repo-xray",
      target: "acme/a-repository-with-quite-a-long-name-for-a-monorepo",
      execution: "simulated",
      stalled: true,
      lastEventAt: minutesAgo(9),
      step: { id: "run-the-test-suite-in-the-sandbox", state: "running" },
    }),
    children: [],
  },
];

function base(runId: string, minutesLeft: number) {
  const expiresAt = new Date(FIXTURE_NOW.getTime() + minutesLeft * 60_000);
  return {
    approvalRowId: `row-${runId.slice(0, 8)}`,
    runId,
    requestedAt: new Date(expiresAt.getTime() - 10 * 60_000).toISOString(),
    expiresAt: expiresAt.toISOString(),
    expired: minutesLeft <= 0,
  };
}

export const fullArguments = JSON.stringify({
  ticket: "PAY-1482",
  body: "Refund issued; closing after confirmation from the customer.",
  callbackUrl: `https://${LONG_HOST}/hooks/tickets/PAY-1482/comments?source=delegate`,
});

export const inboxItems: InboxItem[] = [
  {
    ...base("33333333-3333-4333-8333-333333333333", 7),
    kind: "plan",
    mission: "automation-audit",
    target: "acme.example",
    steps: planSteps,
  },
  {
    ...base("55555555-5555-4555-8555-555555555555", 1.5),
    kind: "tool",
    mission: "custom-goal",
    target: null,
    approvalId: "ap_1",
    tool: "mcp__tickets__add_comment_to_an_existing_support_ticket",
    server: "tickets",
    action: "add_comment_to_an_existing_support_ticket",
    capability: "connector.write",
    policyId: "guest-demo+connectors",
    argsJson: fullArguments,
    argsSha256: SHA,
  },
  {
    ...base("66666666-6666-4666-8666-666666666666", 12),
    kind: "ship",
    mission: "ship-a-pr",
    target: "acme/widget",
    mode: "pull_request",
    repo: "acme/widget",
    branch: "delegate/fix-the-flaky-retry-test-in-the-payments-client",
    base: "main",
    diffStat: { files: 3, additions: 42, deletions: 7 },
    title: "Fix the flaky retry test",
    reason: "Tests pass after the change; opening a pull request needs your approval.",
    baseline: { command: "pnpm test", exitCode: 1, passed: false, durationMs: 41_200 },
    after: { command: "pnpm test", exitCode: 0, passed: true, durationMs: 39_800 },
  },
  {
    ...base("77777777-7777-4777-8777-777777777777", -1),
    kind: "tool",
    mission: "custom-goal",
    target: "acme.example",
    approvalId: "ap_2",
    tool: "mcp__crm__update_contact",
    server: "crm",
    action: "update_contact",
    capability: "connector.write",
    policyId: null,
    argsJson: '{"id":"c_91","email":"sam@acme.example"}',
    argsSha256: SHA.split("").reverse().join(""),
  },
];

export function busyMissionControl(): MissionControl {
  const empty = emptyMissionControl(FIXTURE_NOW);
  return {
    ...empty,
    hasWorkspace: true,
    runsPausedAt: minutesAgo(30),
    active: { runs: activeRuns, truncated: true },
    inbox: { items: inboxItems, truncated: true },
    usage: {
      ...empty.usage,
      quota: { ...empty.usage.quota, lastHour: 5, today: 9 },
      missions: [
        { mission: "company-xray", runs: 6, inputTokens: 1_204_331, outputTokens: 88_112 },
        { mission: "automation-audit", runs: 2, inputTokens: 402_118, outputTokens: 31_007 },
        { mission: "ship-a-pr", runs: 1, inputTokens: 0, outputTokens: 0 },
      ],
      fallbacks: {
        total: 4,
        exhausted: 1,
        byReason: [
          { reason: "rate_limited", count: 3 },
          { reason: "context_window_exceeded_for_the_selected_model", count: 1 },
        ],
      },
      sandbox: { commands: 14, seconds: 812.4 },
      crawl: { pages: 137, siteCrawls: 3, uncountedCrawls: 1 },
    },
    switchActivity: [
      { id: 3, action: "workspace.runs_paused", at: minutesAgo(30), runs: null },
      { id: 2, action: "workspace.runs_stopped", at: minutesAgo(90), runs: 2 },
      { id: 1, action: "workspace.runs_resumed", at: minutesAgo(200), runs: null },
    ],
    decisions: {
      counts: { allow: 212, deny: 3, require_approval: 5 },
      entries: [
        {
          runId: "55555555-5555-4555-8555-555555555555",
          seq: 41,
          at: minutesAgo(1),
          mission: "custom-goal",
          target: null,
          stepId: "act",
          tool: "mcp__tickets__add_comment_to_an_existing_support_ticket",
          decision: "require_approval",
          policyId: "guest-demo+connectors",
          reason: "Connector tools with side effects need a person's approval before each call.",
          redactions: 0,
        },
        {
          runId: "44444444-4444-4444-8444-444444444444",
          seq: 12,
          at: minutesAgo(6),
          mission: "repo-xray",
          target: "acme/a-repository-with-quite-a-long-name-for-a-monorepo",
          stepId: "fetch",
          tool: "crawl_page",
          decision: "deny",
          policyId: "builtin",
          reason: `Outbound requests to ${LONG_HOST} are not allowed: private or internal host.`,
          redactions: 2,
        },
      ],
    },
  };
}
