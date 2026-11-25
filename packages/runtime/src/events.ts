import { z } from "zod";

export const RUN_EVENT_TYPES = [
  "run.created",
  "plan.proposed",
  "plan.approved",
  "plan.revised",
  "step.started",
  "agent.spawned",
  "agent.message",
  "tool.called",
  "tool.result",
  "policy.decided",
  "artifact.created",
  "artifact.updated",
  "critic.flagged",
  "approval.requested",
  "approval.resolved",
  "usage.updated",
  "step.completed",
  "run.completed",
  "run.failed",
  "model.fallback",
  "connector.call",
  "sandbox.command",
  "ship.approval.requested",
  "ship.approval.decided",
  "pr.opened",
  "playbook.applied",
  "child.started",
  "child.completed",
] as const;

export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

const id = z.string().min(1);
const tokenCount = z.number().int().nonnegative();
const redactionCount = z.number().int().positive().optional();
export const MicroUsdSchema = z.number().int().nonnegative();

export const AGENT_ROLES = [
  "researcher",
  "analyst",
  "builder",
  "engineer",
  "critic",
  "editor",
] as const;
export const AgentRoleSchema = z.enum(AGENT_ROLES);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

export const MODEL_ROLES = ["planner", "worker", "fast"] as const;
export const ModelRoleSchema = z.enum(MODEL_ROLES);
export type ModelRole = z.infer<typeof ModelRoleSchema>;

export const ActorSchema = z.object({
  type: z.enum(["member", "guest", "agent", "system"]),
  id,
});
export type Actor = z.infer<typeof ActorSchema>;

export const PhaseIdSchema = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);

export const PlanStepSchema = z.object({
  id,
  role: AgentRoleSchema,
  objective: z.string().min(1),
  inputs: z.array(id),
  capabilities: z.array(id),
  acceptance: z.array(z.string().min(1)),
  budgetShare: z.number().min(0).max(1),
  phase: PhaseIdSchema.optional(),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const PlanPhaseSchema = z.object({
  id: PhaseIdSchema,
  objective: z.string().trim().min(1).max(400),
  budgetShare: z.number().min(0).max(1),
  dependsOn: z.array(PhaseIdSchema).max(6).default([]),
});
export type PlanPhase = z.infer<typeof PlanPhaseSchema>;
export const PlanPhasesSchema = z.array(PlanPhaseSchema).max(6);

const BUDGET_SHARE_TOLERANCE = 1e-9;

export const PlanStepsSchema = z.array(PlanStepSchema).superRefine((steps, ctx) => {
  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id)) ctx.addIssue({ code: "custom", message: `Duplicate step id ${step.id}` });
    ids.add(step.id);
  }
  for (const step of steps) {
    for (const input of step.inputs) {
      if (!ids.has(input)) {
        ctx.addIssue({
          code: "custom",
          message: `Step ${step.id} input references unknown step ${input}`,
        });
      }
    }
  }
  const totalShare = steps.reduce((sum, step) => sum + step.budgetShare, 0);
  if (totalShare > 1 + BUDGET_SHARE_TOLERANCE) {
    ctx.addIssue({
      code: "custom",
      message: `Plan budgetShare values sum to ${totalShare}, more than 1`,
    });
  }
});

export const ROUTING_ORDERINGS = ["configured", "learned"] as const;
export const RoutingOrderingSchema = z.enum(ROUTING_ORDERINGS);
export type RoutingOrdering = z.infer<typeof RoutingOrderingSchema>;

export const UsageSchema = z.object({
  inputTokens: tokenCount,
  outputTokens: tokenCount,
  cacheReadTokens: tokenCount,
  cacheWriteTokens: tokenCount,
  costMicroUsd: MicroUsdSchema,
  provider: id,
  model: id,
  estimated: z.boolean().optional(),
  role: ModelRoleSchema.optional(),
  ordering: RoutingOrderingSchema.optional(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const CRITIC_CATEGORIES = ["claim", "uncited", "injection_suspected"] as const;
export const CriticCategorySchema = z.enum(CRITIC_CATEGORIES);
export type CriticCategory = z.infer<typeof CriticCategorySchema>;

export const PolicyDecisionKindSchema = z.enum(["allow", "deny", "require_approval"]);
export type PolicyDecisionKind = z.infer<typeof PolicyDecisionKindSchema>;

export const ServingModelSchema = z.object({ provider: id, model: id });
export type ServingModel = z.infer<typeof ServingModelSchema>;

export const FALLBACK_REASONS = [
  "rate_limited",
  "server_error",
  "timeout",
  "network_error",
  "context_too_small",
  "tools_unsupported",
  "unhealthy",
  "client_error",
  "model_unavailable",
  "exceeds_provider_capacity",
] as const;
export const FallbackReasonSchema = z.enum(FALLBACK_REASONS);
export type FallbackReason = z.infer<typeof FallbackReasonSchema>;

export const ModelFallbackPayloadSchema = z.object({
  role: ModelRoleSchema,
  from: ServingModelSchema,
  to: ServingModelSchema.nullable(),
  reason: FallbackReasonSchema,
  retryAfterMs: z.number().int().nonnegative().optional(),
  ordering: RoutingOrderingSchema.optional(),
});
export type ModelFallbackPayload = z.infer<typeof ModelFallbackPayloadSchema>;

const envelope = {
  runId: id,
  seq: z.number().int().nonnegative(),
  at: z.iso.datetime({ offset: true }),
  stepId: id.optional(),
  agentId: id.optional(),
};

function event<T extends RunEventType, P extends z.ZodType>(type: T, payload: P) {
  return z.object({ ...envelope, type: z.literal(type), payload });
}

function stepEvent<T extends RunEventType, P extends z.ZodType>(type: T, payload: P) {
  return z.object({ ...envelope, stepId: id, type: z.literal(type), payload });
}

const planSteps = PlanStepsSchema;

export const PlanDiffSchema = z.object({
  added: z.array(id),
  removed: z.array(id),
  changed: z.array(id),
});

export const PLAN_SOURCES = ["planner", "default", "reviewer"] as const;
export const PlanSourceSchema = z.enum(PLAN_SOURCES);
export type PlanSource = z.infer<typeof PlanSourceSchema>;

export const SpecificityReportSchema = z.object({
  score: z.number().min(0).max(1).nullable(),
  specific: tokenCount,
  generic: tokenCount,
  movedToContext: tokenCount,
  dropped: tokenCount,
});
export type SpecificityReport = z.infer<typeof SpecificityReportSchema>;

export const CriticReportSchema = z.object({
  claimsChecked: tokenCount,
  supported: tokenCount,
  fixed: tokenCount,
  weak: tokenCount.optional(),
  removed: tokenCount,
  unverified: tokenCount,
  fixLoops: tokenCount,
  citationAccuracy: z.number().min(0).max(1).nullable(),
  draftCitationAccuracy: z.number().min(0).max(1).nullable(),
  publishedAccuracy: z.number().min(0).max(1).nullable().optional(),
  split: tokenCount.optional(),
  genericRemoved: tokenCount.optional(),
  specificity: SpecificityReportSchema.optional(),
});
export type CriticReport = z.infer<typeof CriticReportSchema>;

export const RESEARCH_STOP_REASONS = [
  "coverage_met",
  "deadline",
  "max_rounds",
  "no_candidates",
  "no_new_evidence",
  "no_gaps",
] as const;
export const ResearchStopReasonSchema = z.enum(RESEARCH_STOP_REASONS);

export const ResearchRoundSchema = z.object({
  round: z.number().int().positive(),
  thin: z.array(z.string().min(1).max(120)).max(20),
  targets: z.array(z.string().min(1).max(300)).max(12),
  selectedBy: z.enum(["planner", "rule"]),
  fetched: tokenCount,
  newFacts: tokenCount,
  coverageBefore: z.number().min(0).max(1),
  coverageAfter: z.number().min(0).max(1),
});
export type ResearchRound = z.infer<typeof ResearchRoundSchema>;

export const ResearchReportSchema = z.object({
  rounds: z.array(ResearchRoundSchema).max(10),
  stopReason: ResearchStopReasonSchema,
  coverage: z.number().min(0).max(1),
});
export type ResearchReport = z.infer<typeof ResearchReportSchema>;

export const DeliverableVerificationSchema = z.object({
  citationAccuracy: z.number().min(0).max(1).nullable(),
  publishedAccuracy: z.number().min(0).max(1).nullable().optional(),
  specificity: SpecificityReportSchema,
  research: ResearchReportSchema.optional(),
});
export type DeliverableVerification = z.infer<typeof DeliverableVerificationSchema>;

export const SANDBOX_COMMAND_PURPOSES = [
  "setup",
  "clone",
  "install",
  "baseline",
  "engineer",
  "verify",
  "diff",
] as const;
export const SandboxCommandPurposeSchema = z.enum(SANDBOX_COMMAND_PURPOSES);
export type SandboxCommandPurpose = z.infer<typeof SandboxCommandPurposeSchema>;

export const SANDBOX_OUTPUT_MAX_CHARS = 4_000;

export const SandboxCommandPayloadSchema = z.object({
  commandId: id,
  purpose: SandboxCommandPurposeSchema,
  command: z.string().min(1).max(500),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
  timedOut: z.boolean(),
  output: z.string().max(SANDBOX_OUTPUT_MAX_CHARS),
  truncated: z.boolean(),
  redactions: redactionCount,
});
export type SandboxCommandPayload = z.infer<typeof SandboxCommandPayloadSchema>;

export const TestRunSummarySchema = z.object({
  command: z.string().max(500).nullable(),
  exitCode: z.number().int().nullable(),
  passed: z.boolean().nullable(),
  durationMs: z.number().int().nonnegative(),
  timedOut: z.boolean().optional(),
});
export type TestRunSummary = z.infer<typeof TestRunSummarySchema>;

export const SHIP_MODES = ["pull_request", "patch"] as const;
export const ShipModeSchema = z.enum(SHIP_MODES);
export type ShipMode = z.infer<typeof ShipModeSchema>;

export const DiffStatSchema = z.object({
  files: tokenCount,
  additions: tokenCount,
  deletions: tokenCount,
});
export type DiffStat = z.infer<typeof DiffStatSchema>;

export const ShipApprovalRequestedPayloadSchema = z.object({
  approvalId: id,
  mode: ShipModeSchema,
  repo: z.string().min(3).max(200),
  base: z.string().min(1).max(250),
  branch: z.string().min(1).max(250),
  title: z.string().min(1).max(200),
  diffStat: DiffStatSchema,
  patchArtifactId: id,
  baseline: TestRunSummarySchema,
  after: TestRunSummarySchema,
  reason: z.string().min(1).max(500),
});
export type ShipApprovalRequestedPayload = z.infer<typeof ShipApprovalRequestedPayloadSchema>;

export const ShipApprovalDecidedPayloadSchema = z.object({
  approvalId: id,
  decision: z.enum(["approved", "rejected"]),
  decidedBy: ActorSchema,
  reason: z.string().max(500).optional(),
});
export type ShipApprovalDecidedPayload = z.infer<typeof ShipApprovalDecidedPayloadSchema>;

export const PullRequestOpenedPayloadSchema = z.object({
  url: z.url(),
  number: z.number().int().positive(),
  repo: z.string().min(3).max(200),
  branch: z.string().min(1).max(250),
  base: z.string().min(1).max(250),
  commitSha: z.string().regex(/^[0-9a-f]{40}$/),
});
export type PullRequestOpenedPayload = z.infer<typeof PullRequestOpenedPayloadSchema>;

export const ForkOriginSchema = z.object({
  runId: id,
  stepId: id,
  parentSeq: z.number().int().nonnegative(),
  seededThrough: z.number().int().positive(),
  objectiveEdited: z.boolean(),
});
export type ForkOrigin = z.infer<typeof ForkOriginSchema>;

export const CHILD_MISSION_IDS = [
  "custom-goal",
  "company-xray",
  "automation-audit",
  "build-agent",
  "repo-xray",
  "ship-a-pr",
] as const;
export const ChildMissionIdSchema = z.enum(CHILD_MISSION_IDS);
export type ChildMissionId = z.infer<typeof ChildMissionIdSchema>;

export const AutopilotLinkSchema = z.object({
  parentRunId: z.uuid(),
  nodeId: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
});
export type AutopilotLink = z.infer<typeof AutopilotLinkSchema>;

export const ChildHandoffSchema = z.object({
  contract: z.string().min(1).max(80),
  fromRunId: z.uuid(),
  artifactId: id,
  itemId: z.string().min(1).max(80).optional(),
  itemTitle: z.string().min(1).max(160).optional(),
});
export type ChildHandoff = z.infer<typeof ChildHandoffSchema>;

export const CHILD_APPROVAL_MODES = ["auto", "human"] as const;
export const CHILD_SIDE_EFFECT_MODES = ["ask", "patch_only", "none"] as const;

export const ChildStartedPayloadSchema = z.object({
  childRunId: z.uuid(),
  nodeId: AutopilotLinkSchema.shape.nodeId,
  missionId: ChildMissionIdSchema,
  label: z.string().min(1).max(120),
  input: z.record(z.string(), z.unknown()),
  from: ChildHandoffSchema.optional(),
  approvals: z.object({
    plan: z.enum(CHILD_APPROVAL_MODES),
    sideEffects: z.enum(CHILD_SIDE_EFFECT_MODES),
  }),
});
export type ChildStartedPayload = z.infer<typeof ChildStartedPayloadSchema>;

export const ChildLinkSchema = z.object({
  label: z.string().min(1).max(60),
  href: z.string().min(1).max(500),
});

export const ChildOutcomeSchema = z.object({
  status: z.enum(["completed", "failed"]),
  summary: z.string().max(600),
  error: z.object({ code: id, message: z.string().max(400) }).optional(),
  deliverable: z.object({ artifactId: id, kind: id, title: z.string().min(1).max(200) }).nullable(),
  metrics: z
    .array(z.object({ label: z.string().min(1).max(40), value: z.string().min(1).max(80) }))
    .max(6),
  links: z.array(ChildLinkSchema).max(4),
  needsHuman: z.array(z.string().min(1).max(300)).max(4),
});
export type ChildOutcome = z.infer<typeof ChildOutcomeSchema>;

export const ChildCompletedPayloadSchema = z.object({
  childRunId: z.uuid(),
  nodeId: AutopilotLinkSchema.shape.nodeId,
  missionId: ChildMissionIdSchema,
  outcome: ChildOutcomeSchema,
  tokens: tokenCount,
});
export type ChildCompletedPayload = z.infer<typeof ChildCompletedPayloadSchema>;

export const PlaybookAppliedEntrySchema = z.object({
  id: z.string().regex(/^pb_[0-9a-f]{8}$/),
  scope: z.enum(["workspace", "house"]),
  kind: z.string().min(1).max(40),
  polarity: z.enum(["keep", "avoid"]),
  text: z.string().min(1).max(240),
  stepId: id.optional(),
  evidence: z.number().int().positive(),
  score: z.number().min(0).max(1),
});
export type PlaybookAppliedEntry = z.infer<typeof PlaybookAppliedEntrySchema>;

export const PlaybookAppliedSchema = z.object({
  key: z.string().min(1).max(100),
  runs: tokenCount,
  sources: z
    .array(
      z.object({ scope: z.enum(["workspace", "house"]), version: z.number().int().nonnegative() }),
    )
    .max(2),
  entries: z.array(PlaybookAppliedEntrySchema).min(1).max(8),
  tokens: tokenCount,
});
export type PlaybookApplied = z.infer<typeof PlaybookAppliedSchema>;

export const RunEventSchema = z.discriminatedUnion("type", [
  event(
    "run.created",
    z.object({
      workspaceId: id,
      missionId: id,
      input: z.record(z.string(), z.unknown()),
      actor: ActorSchema,
      budget: z.object({ maxTokens: tokenCount, maxMicroUsd: MicroUsdSchema }),
      forkedFrom: ForkOriginSchema.optional(),
      autopilot: AutopilotLinkSchema.optional(),
    }),
  ),
  event(
    "plan.proposed",
    z.object({
      version: z.number().int().positive(),
      steps: planSteps,
      phases: PlanPhasesSchema.optional(),
      source: PlanSourceSchema.optional(),
      rationale: z.string().max(2000).optional(),
    }),
  ),
  event(
    "plan.approved",
    z.object({
      version: z.number().int().positive(),
      approvedBy: ActorSchema,
      reason: z.string().min(1).optional(),
    }),
  ),
  event(
    "plan.revised",
    z.object({
      version: z.number().int().positive(),
      steps: planSteps,
      phases: PlanPhasesSchema.optional(),
      reason: z.string().min(1),
      diff: PlanDiffSchema.optional(),
      source: PlanSourceSchema.optional(),
      requiresApproval: z.boolean().optional(),
    }),
  ),
  stepEvent("step.started", z.object({})),
  stepEvent(
    "agent.spawned",
    z.object({ role: AgentRoleSchema, modelRole: ModelRoleSchema }),
  ).extend({ agentId: id }),
  stepEvent("agent.message", z.object({ text: z.string() })).extend({ agentId: id }),
  stepEvent(
    "tool.called",
    z.object({ toolCallId: id, tool: id, capability: id, argsSummary: z.string() }),
  ),
  stepEvent(
    "tool.result",
    z.object({
      toolCallId: id,
      tool: id,
      ok: z.boolean(),
      summary: z.string(),
      durationMs: z.number().int().nonnegative(),
      artifactId: id.optional(),
      error: z.string().optional(),
      redactions: redactionCount,
    }),
  ),
  event(
    "policy.decided",
    z.object({
      toolCallId: id.optional(),
      tool: id,
      decision: PolicyDecisionKindSchema,
      policyId: id,
      reason: z.string().min(1),
      redactions: redactionCount,
    }),
  ),
  event(
    "artifact.created",
    z.object({
      artifactId: id,
      kind: id,
      title: z.string().min(1),
      version: z.literal(1),
      content: z.unknown().optional(),
    }),
  ),
  event(
    "artifact.updated",
    z.object({
      artifactId: id,
      version: z.number().int().min(2),
      title: z.string().min(1).optional(),
      content: z.unknown().optional(),
    }),
  ),
  event(
    "critic.flagged",
    z.object({
      claimId: id,
      claim: z.string().min(1),
      reason: z.string().min(1),
      severity: z.enum(["info", "warn", "error"]),
      sourceId: id.optional(),
      category: CriticCategorySchema.optional(),
    }),
  ),
  event(
    "approval.requested",
    z.object({
      approvalId: id,
      toolCallId: id.optional(),
      policyId: id,
      reason: z.string().min(1),
      summary: z.string().min(1),
    }),
  ),
  event(
    "approval.resolved",
    z.object({
      approvalId: id,
      resolution: z.enum(["approved", "rejected"]),
      resolvedBy: ActorSchema,
      note: z.string().optional(),
    }),
  ),
  event("usage.updated", UsageSchema),
  stepEvent(
    "step.completed",
    z.object({
      outcome: z.enum(["succeeded", "failed"]),
      summary: z.string(),
      confidence: z.number().min(0).max(1).optional(),
      artifactIds: z.array(id),
      critic: CriticReportSchema.optional(),
      research: ResearchReportSchema.optional(),
      checkpoint: z.unknown().optional(),
    }),
  ),
  event("run.completed", z.object({ summary: z.string() })),
  event(
    "run.failed",
    z.object({
      error: z.object({ code: id, message: z.string() }),
      redactions: redactionCount,
    }),
  ),
  event("model.fallback", ModelFallbackPayloadSchema),
  stepEvent(
    "connector.call",
    z.object({
      toolCallId: id,
      connectorId: id,
      server: id,
      tool: id,
      ok: z.boolean(),
      durationMs: z.number().int().nonnegative(),
      bytes: z.number().int().nonnegative(),
      truncated: z.boolean(),
      summary: z.string(),
      redactions: redactionCount,
    }),
  ),
  stepEvent("sandbox.command", SandboxCommandPayloadSchema),
  event("ship.approval.requested", ShipApprovalRequestedPayloadSchema),
  event("ship.approval.decided", ShipApprovalDecidedPayloadSchema),
  event("pr.opened", PullRequestOpenedPayloadSchema),
  event("playbook.applied", PlaybookAppliedSchema),
  event("child.started", ChildStartedPayloadSchema),
  event("child.completed", ChildCompletedPayloadSchema),
]);

export type RunEvent = z.infer<typeof RunEventSchema>;
export type RunEventOf<T extends RunEventType> = Extract<RunEvent, { type: T }>;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type RunEventDraft = DistributiveOmit<RunEvent, "seq" | "at">;

export function parseRunEvent(input: unknown): RunEvent {
  return RunEventSchema.parse(input);
}

export type PlanDiff = z.infer<typeof PlanDiffSchema>;

export function diffPlans(previous: readonly PlanStep[], next: readonly PlanStep[]): PlanDiff {
  const before = new Map(previous.map((step) => [step.id, step]));
  const after = new Map(next.map((step) => [step.id, step]));
  return {
    added: next.filter((step) => !before.has(step.id)).map((step) => step.id),
    removed: previous.filter((step) => !after.has(step.id)).map((step) => step.id),
    changed: next
      .filter((step) => {
        const old = before.get(step.id);
        return old !== undefined && JSON.stringify(old) !== JSON.stringify(step);
      })
      .map((step) => step.id),
  };
}

export type RunStatus =
  "planning" | "awaiting_plan_approval" | "running" | "awaiting_approval" | "completed" | "failed";

export type StepStatus = "pending" | "running" | "succeeded" | "failed";

export interface StepState {
  id: string;
  status: StepStatus;
  startedAt?: string;
  completedAt?: string;
  summary?: string;
  servedBy?: ServingModel;
}

export interface RunTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costMicroUsd: number;
  toolCalls: number;
  policyDenials: number;
}

export interface PendingApproval {
  approvalId: string;
  policyId: string;
  reason: string;
  summary: string;
  seq: number;
  stepId?: string;
  toolCallId?: string;
}

export interface ArtifactIndexEntry {
  artifactId: string;
  kind: string;
  title: string;
  version: number;
  stepId?: string;
}

export interface PlanRevision {
  version: number;
  reason: string;
  diff: PlanDiff;
  seq: number;
}

export interface FallbackRecord extends ModelFallbackPayload {
  seq: number;
  stepId?: string;
}

export interface ShipApprovalState extends ShipApprovalRequestedPayload {
  seq: number;
  status: "pending" | "approved" | "rejected";
  decidedBy?: Actor;
  decisionReason?: string;
}

export interface ShipState {
  commands: number;
  failedCommands: number;
  approval?: ShipApprovalState;
  pullRequest?: PullRequestOpenedPayload;
}

export interface ChildRunState extends ChildStartedPayload {
  seq: number;
  startedAt: string;
  completedAt?: string;
  outcome?: ChildOutcome;
  tokens?: number;
}

export interface RunState {
  runId: string;
  status: RunStatus;
  workspaceId?: string;
  missionId?: string;
  forkedFrom?: ForkOrigin;
  autopilot?: AutopilotLink;
  children: ChildRunState[];
  plan: { version: number; steps: PlanStep[]; approved: boolean; phases?: PlanPhase[] } | null;
  planRevisions: PlanRevision[];
  steps: StepState[];
  totals: RunTotals;
  pendingApprovals: PendingApproval[];
  artifacts: Record<string, ArtifactIndexEntry>;
  fallbacks: FallbackRecord[];
  ship?: ShipState;
  playbook?: PlaybookApplied & { seq: number };
  summary?: string;
  error?: { code: string; message: string };
  lastSeq: number;
}

export const SHIP_APPROVAL_POLICY_ID = "ship-approval";

export class EventOrderError extends Error {
  override readonly name = "EventOrderError";
}

type Lifecycle = "planning" | "awaiting_plan_approval" | "running" | "completed" | "failed";

function stepsForPlan(plan: readonly PlanStep[], existing: readonly StepState[]): StepState[] {
  const known = new Map(existing.map((step) => [step.id, step]));
  return plan.map((step) => known.get(step.id) ?? { id: step.id, status: "pending" });
}

function emptyArtifacts(): Record<string, ArtifactIndexEntry> {
  return Object.create(null) as Record<string, ArtifactIndexEntry>;
}

function isTerminal(lifecycle: Lifecycle): boolean {
  return lifecycle === "completed" || lifecycle === "failed";
}

export function foldRun(events: readonly RunEvent[]): RunState {
  const first = events[0];
  if (first === undefined) throw new EventOrderError("Cannot fold an empty event log");
  if (first.type !== "run.created") {
    throw new EventOrderError(`First event must be run.created, got ${first.type}`);
  }

  let lifecycle: Lifecycle = "planning";
  const state: RunState = {
    runId: first.runId,
    status: "planning",
    plan: null,
    planRevisions: [],
    steps: [],
    totals: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costMicroUsd: 0,
      toolCalls: 0,
      policyDenials: 0,
    },
    pendingApprovals: [],
    artifacts: emptyArtifacts(),
    fallbacks: [],
    children: [],
    lastSeq: -1,
  };

  const updateStep = (stepId: string, update: (step: StepState) => StepState) => {
    const index = state.steps.findIndex((step) => step.id === stepId);
    const current = state.steps[index];
    if (current === undefined) throw new EventOrderError(`Event refers to unknown step ${stepId}`);
    state.steps[index] = update(current);
  };

  for (const event of events) {
    if (event.runId !== state.runId) {
      throw new EventOrderError(
        `Event seq ${event.seq} belongs to run ${event.runId}, not ${state.runId}`,
      );
    }
    if (event.seq <= state.lastSeq) {
      throw new EventOrderError(`Event seq ${event.seq} is not after ${state.lastSeq}`);
    }
    if (isTerminal(lifecycle)) {
      throw new EventOrderError(
        `Event seq ${event.seq} (${event.type}) arrived after the run reached terminal state ${lifecycle}`,
      );
    }
    if (event.type === "run.created" && event !== first) {
      throw new EventOrderError(`Event seq ${event.seq} repeats run.created`);
    }
    if (event.stepId !== undefined && !state.steps.some((step) => step.id === event.stepId)) {
      throw new EventOrderError(
        `Event seq ${event.seq} (${event.type}) refers to unknown step ${event.stepId}`,
      );
    }
    state.lastSeq = event.seq;

    switch (event.type) {
      case "run.created":
        state.workspaceId = event.payload.workspaceId;
        state.missionId = event.payload.missionId;
        if (event.payload.forkedFrom !== undefined) state.forkedFrom = event.payload.forkedFrom;
        if (event.payload.autopilot !== undefined) state.autopilot = event.payload.autopilot;
        lifecycle = "planning";
        break;
      case "plan.proposed":
        state.plan = {
          version: event.payload.version,
          steps: event.payload.steps,
          approved: false,
          ...(event.payload.phases === undefined ? {} : { phases: event.payload.phases }),
        };
        state.steps = stepsForPlan(event.payload.steps, []);
        lifecycle = "awaiting_plan_approval";
        break;
      case "plan.approved":
        if (state.plan?.version !== event.payload.version) {
          throw new EventOrderError(
            `plan.approved for version ${event.payload.version} does not match the current plan version ${state.plan?.version ?? "none"}`,
          );
        }
        state.plan.approved = true;
        lifecycle = "running";
        break;
      case "plan.revised":
        state.planRevisions.push({
          version: event.payload.version,
          reason: event.payload.reason,
          diff: diffPlans(state.plan?.steps ?? [], event.payload.steps),
          seq: event.seq,
        });
        state.plan = {
          version: event.payload.version,
          steps: event.payload.steps,
          approved:
            event.payload.requiresApproval === true ? false : (state.plan?.approved ?? false),
          ...(event.payload.phases === undefined ? {} : { phases: event.payload.phases }),
        };
        state.steps = stepsForPlan(event.payload.steps, state.steps);
        break;
      case "step.started":
        updateStep(event.stepId, (step) => ({ ...step, status: "running", startedAt: event.at }));
        break;
      case "step.completed":
        updateStep(event.stepId, (step) => ({
          ...step,
          status: event.payload.outcome,
          completedAt: event.at,
          summary: event.payload.summary,
        }));
        break;
      case "tool.called":
        state.totals.toolCalls += 1;
        break;
      case "policy.decided":
        if (event.payload.decision === "deny") state.totals.policyDenials += 1;
        break;
      case "usage.updated": {
        const usage = event.payload;
        state.totals.inputTokens += usage.inputTokens;
        state.totals.outputTokens += usage.outputTokens;
        state.totals.cacheReadTokens += usage.cacheReadTokens;
        state.totals.cacheWriteTokens += usage.cacheWriteTokens;
        state.totals.costMicroUsd += usage.costMicroUsd;
        if (event.stepId !== undefined) {
          updateStep(event.stepId, (step) => ({
            ...step,
            servedBy: { provider: usage.provider, model: usage.model },
          }));
        }
        break;
      }
      case "artifact.created":
        state.artifacts[event.payload.artifactId] = {
          artifactId: event.payload.artifactId,
          kind: event.payload.kind,
          title: event.payload.title,
          version: event.payload.version,
          ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
        };
        break;
      case "artifact.updated": {
        const existing = state.artifacts[event.payload.artifactId];
        if (existing !== undefined) {
          state.artifacts[event.payload.artifactId] = {
            ...existing,
            version: event.payload.version,
            ...(event.payload.title === undefined ? {} : { title: event.payload.title }),
          };
        }
        break;
      }
      case "approval.requested":
        state.pendingApprovals.push({
          approvalId: event.payload.approvalId,
          policyId: event.payload.policyId,
          reason: event.payload.reason,
          summary: event.payload.summary,
          seq: event.seq,
          ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
          ...(event.payload.toolCallId === undefined
            ? {}
            : { toolCallId: event.payload.toolCallId }),
        });
        break;
      case "approval.resolved":
        state.pendingApprovals = state.pendingApprovals.filter(
          (approval) => approval.approvalId !== event.payload.approvalId,
        );
        break;
      case "model.fallback":
        state.fallbacks.push({
          ...event.payload,
          seq: event.seq,
          ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
        });
        break;
      case "sandbox.command": {
        const ship = (state.ship ??= { commands: 0, failedCommands: 0 });
        ship.commands += 1;
        if (event.payload.exitCode !== 0) ship.failedCommands += 1;
        break;
      }
      case "ship.approval.requested": {
        const ship = (state.ship ??= { commands: 0, failedCommands: 0 });
        ship.approval = { ...event.payload, seq: event.seq, status: "pending" };
        state.pendingApprovals = state.pendingApprovals.filter(
          (pending) => pending.approvalId !== event.payload.approvalId,
        );
        state.pendingApprovals.push({
          approvalId: event.payload.approvalId,
          policyId: SHIP_APPROVAL_POLICY_ID,
          reason: event.payload.reason,
          summary: event.payload.title,
          seq: event.seq,
          ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
        });
        break;
      }
      case "ship.approval.decided": {
        const approval = state.ship?.approval;
        if (approval?.approvalId !== event.payload.approvalId)
          throw new EventOrderError(
            `ship.approval.decided for ${event.payload.approvalId} has no matching request`,
          );
        approval.status = event.payload.decision;
        approval.decidedBy = event.payload.decidedBy;
        if (event.payload.reason !== undefined) approval.decisionReason = event.payload.reason;
        state.pendingApprovals = state.pendingApprovals.filter(
          (pending) => pending.approvalId !== event.payload.approvalId,
        );
        break;
      }
      case "pr.opened": {
        const ship = (state.ship ??= { commands: 0, failedCommands: 0 });
        if (ship.approval?.status !== "approved")
          throw new EventOrderError(`pr.opened at seq ${event.seq} without an approved ship`);
        ship.pullRequest = event.payload;
        break;
      }
      case "playbook.applied":
        state.playbook = { ...event.payload, seq: event.seq };
        break;
      case "child.started": {
        const payload = event.payload;
        if (
          state.children.some(
            (child) => child.childRunId === payload.childRunId || child.nodeId === payload.nodeId,
          )
        )
          throw new EventOrderError(`child.started at seq ${event.seq} repeats a child`);
        if (state.children.some((child) => child.outcome === undefined))
          throw new EventOrderError(
            `child.started at seq ${event.seq} while another child is still running`,
          );
        state.children.push({ ...payload, seq: event.seq, startedAt: event.at });
        lifecycle = "running";
        break;
      }
      case "child.completed": {
        const payload = event.payload;
        const child = state.children.find((entry) => entry.childRunId === payload.childRunId);
        if (child?.nodeId !== payload.nodeId)
          throw new EventOrderError(
            `child.completed at seq ${event.seq} has no matching child.started`,
          );
        if (child.outcome !== undefined)
          throw new EventOrderError(`child.completed at seq ${event.seq} repeats a child`);
        child.outcome = payload.outcome;
        child.completedAt = event.at;
        child.tokens = payload.tokens;
        break;
      }
      case "run.completed":
        state.summary = event.payload.summary;
        lifecycle = "completed";
        break;
      case "run.failed":
        state.error = event.payload.error;
        lifecycle = "failed";
        break;
      case "agent.spawned":
      case "agent.message":
      case "tool.result":
      case "critic.flagged":
      case "connector.call":
        break;
    }
  }

  state.status =
    lifecycle === "running" && state.pendingApprovals.length > 0 ? "awaiting_approval" : lifecycle;
  return state;
}
