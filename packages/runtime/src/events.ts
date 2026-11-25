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
  "sandbox.command",
  "ship.approval.requested",
  "ship.approval.decided",
  "pr.opened",
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

export const PlanStepSchema = z.object({
  id,
  role: AgentRoleSchema,
  objective: z.string().min(1),
  inputs: z.array(id),
  capabilities: z.array(id),
  acceptance: z.array(z.string().min(1)),
  budgetShare: z.number().min(0).max(1),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

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

export const UsageSchema = z.object({
  inputTokens: tokenCount,
  outputTokens: tokenCount,
  cacheReadTokens: tokenCount,
  cacheWriteTokens: tokenCount,
  costMicroUsd: MicroUsdSchema,
  provider: id,
  model: id,
  estimated: z.boolean().optional(),
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
});
export type CriticReport = z.infer<typeof CriticReportSchema>;

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
    }),
  ),
  event(
    "plan.proposed",
    z.object({
      version: z.number().int().positive(),
      steps: planSteps,
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
      reason: z.string().min(1),
      diff: PlanDiffSchema.optional(),
      source: PlanSourceSchema.optional(),
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
  stepEvent("sandbox.command", SandboxCommandPayloadSchema),
  event("ship.approval.requested", ShipApprovalRequestedPayloadSchema),
  event("ship.approval.decided", ShipApprovalDecidedPayloadSchema),
  event("pr.opened", PullRequestOpenedPayloadSchema),
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

export interface RunState {
  runId: string;
  status: RunStatus;
  workspaceId?: string;
  missionId?: string;
  forkedFrom?: ForkOrigin;
  plan: { version: number; steps: PlanStep[]; approved: boolean } | null;
  planRevisions: PlanRevision[];
  steps: StepState[];
  totals: RunTotals;
  pendingApprovals: PendingApproval[];
  artifacts: Record<string, ArtifactIndexEntry>;
  fallbacks: FallbackRecord[];
  ship?: ShipState;
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
        lifecycle = "planning";
        break;
      case "plan.proposed":
        state.plan = {
          version: event.payload.version,
          steps: event.payload.steps,
          approved: false,
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
          approved: state.plan?.approved ?? false,
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
        break;
    }
  }

  state.status =
    lifecycle === "running" && state.pendingApprovals.length > 0 ? "awaiting_approval" : lifecycle;
  return state;
}
