import { z } from "zod";

export const API_VERSION = "v1" as const;
export const API_BASE_PATH = "/api/v1" as const;

export const RUN_STATUSES = [
  "planning",
  "awaiting_plan_approval",
  "running",
  "awaiting_approval",
  "completed",
  "failed",
] as const;
export const RunStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const CANCELLED_ERROR_CODE = "cancelled" as const;

export const MISSION_IDS = [
  "company-xray",
  "automation-audit",
  "build-agent",
  "custom-goal",
  "repo-xray",
  "autopilot",
] as const;
export const MissionIdSchema = z.enum(MISSION_IDS);
export type MissionId = z.infer<typeof MissionIdSchema>;

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

export const TERMINAL_EVENT_TYPES = ["run.completed", "run.failed"] as const;

export function isTerminalEventType(type: string): boolean {
  return (TERMINAL_EVENT_TYPES as readonly string[]).includes(type);
}

const timestamp = z.iso.datetime();

export const RUN_INPUT_FIELDS = [
  "url",
  "goal",
  "focus",
  "department",
  "name",
  "opportunityId",
  "ref",
] as const;
export type RunInputField = (typeof RUN_INPUT_FIELDS)[number];

export interface MissionInputRule {
  title: string;
  required: readonly RunInputField[];
  optional: readonly RunInputField[];
  leads: "url" | "goal";
  acceptsParentRun: boolean;
}

export const MISSION_INPUT_RULES: Record<MissionId, MissionInputRule> = {
  "company-xray": {
    title: "Company X-ray",
    required: ["url"],
    optional: ["focus"],
    leads: "url",
    acceptsParentRun: false,
  },
  "automation-audit": {
    title: "AI Automation Audit",
    required: ["url"],
    optional: ["focus", "department"],
    leads: "url",
    acceptsParentRun: false,
  },
  "build-agent": {
    title: "Build-an-Agent",
    required: ["url", "goal"],
    optional: ["name", "opportunityId"],
    leads: "url",
    acceptsParentRun: true,
  },
  "custom-goal": {
    title: "Custom goal",
    required: ["goal"],
    optional: ["url"],
    leads: "goal",
    acceptsParentRun: false,
  },
  "repo-xray": {
    title: "Repo X-ray",
    required: ["url"],
    optional: ["ref"],
    leads: "url",
    acceptsParentRun: false,
  },
  autopilot: {
    title: "Autopilot",
    required: ["goal"],
    optional: ["url"],
    leads: "goal",
    acceptsParentRun: false,
  },
};

export const GOAL_LED_MIN_CHARS = 3;

export const RunInputSchema = z
  .strictObject({
    url: z
      .string()
      .min(1)
      .max(2048)
      .optional()
      .describe("Company website, or a public GitHub repository for repo-xray."),
    goal: z
      .string()
      .trim()
      .min(1)
      .max(900)
      .optional()
      .describe("What the work should achieve (build-agent, custom-goal, autopilot)."),
    focus: z.string().trim().min(1).max(500).optional().describe("What to look at more closely."),
    department: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .optional()
      .describe("Limit an automation audit to one department."),
    name: z.string().trim().min(1).max(80).optional().describe("Name of the assistant to build."),
    opportunityId: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .optional()
      .describe("The audit opportunity a build-agent run implements."),
    ref: z
      .string()
      .trim()
      .regex(/^(?!.*\.\.)(?!\/)[\w./-]{1,200}$/)
      .optional()
      .describe("Branch, tag or commit for repo-xray."),
  })
  .describe("Mission input. Which fields a mission takes is listed on POST /runs.");
export type RunInput = z.infer<typeof RunInputSchema>;

export const CreateRunRequestSchema = z
  .strictObject({
    missionId: MissionIdSchema,
    input: RunInputSchema,
    parentRunId: z
      .uuid()
      .optional()
      .describe("build-agent only: the automation-audit run the opportunity comes from."),
  })
  .superRefine((request, ctx) => {
    const rule = MISSION_INPUT_RULES[request.missionId];
    const allowed = new Set<RunInputField>([...rule.required, ...rule.optional]);
    for (const field of rule.required)
      if (request.input[field] === undefined)
        ctx.addIssue({
          code: "custom",
          path: ["input", field],
          message: `${request.missionId} needs ${field}`,
        });
    for (const field of RUN_INPUT_FIELDS)
      if (request.input[field] !== undefined && !allowed.has(field))
        ctx.addIssue({
          code: "custom",
          path: ["input", field],
          message: `${request.missionId} does not take ${field}`,
        });
    if (
      rule.leads === "goal" &&
      request.input.goal !== undefined &&
      request.input.goal.length < GOAL_LED_MIN_CHARS
    )
      ctx.addIssue({ code: "custom", path: ["input", "goal"], message: "The goal is too short" });
    if (request.parentRunId !== undefined && !rule.acceptsParentRun)
      ctx.addIssue({
        code: "custom",
        path: ["parentRunId"],
        message: `${request.missionId} does not take parentRunId`,
      });
  })
  .describe("A mission and its input.");
export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>;

export const RunStepSchema = z.object({
  id: z.string(),
  objective: z.string(),
  status: z.enum(["pending", "running", "succeeded", "failed"]),
  summary: z.string().optional(),
});
export type RunStep = z.infer<typeof RunStepSchema>;

export const ArtifactRefSchema = z.object({
  artifactId: z.string(),
  kind: z.string(),
  title: z.string(),
  version: z.number().int(),
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

export const ArtifactSchema = ArtifactRefSchema.extend({
  content: z.unknown().describe("The artifact body; its shape depends on `kind`."),
}).describe("One artifact of a run, with its content.");
export type Artifact = z.infer<typeof ArtifactSchema>;

export const RunChildSchema = z.object({
  nodeId: z.string(),
  missionId: z.string(),
  label: z.string(),
  runId: z.uuid().nullable(),
  status: z.string(),
  summary: z.string().nullable(),
  deliverable: z.object({ artifactId: z.string(), kind: z.string(), title: z.string() }).nullable(),
  links: z.array(z.object({ label: z.string(), href: z.string() })),
  needsHuman: z.array(z.string()),
});
export type RunChild = z.infer<typeof RunChildSchema>;

export const RunTotalsSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  costMicroUsd: z.number(),
  toolCalls: z.number(),
});

export const RunErrorSchema = z.object({
  code: z.string().describe("`cancelled` when the run was cancelled."),
  message: z.string(),
});

export const PendingApprovalSchema = z.object({
  approvalId: z.string(),
  summary: z.string(),
});

export const RunViewSchema = z.object({
  id: z.uuid(),
  mission: z.string(),
  status: RunStatusSchema,
  terminal: z.boolean().describe("True once the run completed, failed or was cancelled."),
  createdAt: timestamp,
  finishedAt: timestamp.nullable(),
  totals: RunTotalsSchema,
  pendingPlan: z
    .array(RunStepSchema)
    .nullable()
    .describe("The plan waiting for a decision, when status is awaiting_plan_approval."),
  pendingApprovals: z
    .array(PendingApprovalSchema)
    .describe("Side effects waiting for a human; they are decided in the web app."),
  steps: z.array(RunStepSchema),
  artifacts: z.array(ArtifactRefSchema),
  deliverable: ArtifactSchema.nullable().describe("The final deliverable once the run completed."),
  summary: z.string().nullable(),
  error: RunErrorSchema.nullable(),
  children: z.array(RunChildSchema).optional().describe("Autopilot only: the child runs."),
  autopilotParent: z.object({ runId: z.uuid(), nodeId: z.string() }).nullable().optional(),
});
export type RunView = z.infer<typeof RunViewSchema>;

export const ExecutionSchema = z
  .enum(["live", "simulated"])
  .describe("`simulated` marks a scripted development run; production runs are always `live`.");

export const RunSchema = RunViewSchema.extend({
  target: z.string().nullable().describe("Host, repository or shortened goal the run is about."),
  execution: ExecutionSchema,
  startedAt: timestamp.nullable(),
  webUrl: z.string().describe("Where the run streams live in the web app."),
}).describe("A run: status, steps, artifacts and, once finished, the deliverable.");
export type Run = z.infer<typeof RunSchema>;

export const RunSummarySchema = z
  .object({
    id: z.uuid(),
    mission: z.string(),
    target: z.string().nullable(),
    status: RunStatusSchema,
    execution: ExecutionSchema,
    createdAt: timestamp,
    startedAt: timestamp.nullable(),
    finishedAt: timestamp.nullable(),
    webUrl: z.string(),
  })
  .describe("A run as it appears in a list.");
export type RunSummary = z.infer<typeof RunSummarySchema>;

export const LIST_RUNS_DEFAULT_LIMIT = 20;
export const LIST_RUNS_MAX_LIMIT = 100;

export const ListRunsQuerySchema = z.strictObject({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(LIST_RUNS_MAX_LIMIT)
    .default(LIST_RUNS_DEFAULT_LIMIT)
    .describe("Page size."),
  cursor: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("`nextCursor` of the previous page; omit for the newest runs."),
  status: RunStatusSchema.optional().describe("Only runs in this status."),
});
export type ListRunsQuery = z.input<typeof ListRunsQuerySchema>;

export const RunListSchema = z
  .object({
    data: z.array(RunSummarySchema),
    nextCursor: z
      .string()
      .nullable()
      .describe("Pass as `cursor` for the next page; null at the end."),
  })
  .describe("One page of runs, newest first.");
export type RunList = z.infer<typeof RunListSchema>;

export const RunEventSchema = z
  .object({
    runId: z.uuid(),
    seq: z.number().int().positive().describe("Position in the run's log, starting at 1."),
    at: z.iso.datetime({ offset: true }),
    type: z.string().describe(`One of: ${RUN_EVENT_TYPES.join(", ")}. New types may be added.`),
    stepId: z.string().optional(),
    agentId: z.string().optional(),
    payload: z.record(z.string(), z.unknown()),
  })
  .describe("One entry of a run's append-only event log.");
export type RunEvent = z.infer<typeof RunEventSchema>;

export const LIST_EVENTS_DEFAULT_LIMIT = 200;
export const LIST_EVENTS_MAX_LIMIT = 500;

export const ListRunEventsQuerySchema = z.strictObject({
  after: z.coerce
    .number()
    .int()
    .min(0)
    .max(999_999_999)
    .default(0)
    .describe("Return events with a sequence greater than this."),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(LIST_EVENTS_MAX_LIMIT)
    .default(LIST_EVENTS_DEFAULT_LIMIT)
    .describe("Page size (JSON only)."),
});
export type ListRunEventsQuery = z.input<typeof ListRunEventsQuerySchema>;

export const RunEventPageSchema = z
  .object({
    data: z.array(RunEventSchema),
    nextAfter: z.number().int().nonnegative().describe("Pass as `after` for the next page."),
    hasMore: z.boolean().describe("More events were already stored when this page was read."),
    terminal: z
      .boolean()
      .describe("The run is finished; when hasMore is false too, no event will follow."),
  })
  .describe("One page of a run's events, in order.");
export type RunEventPage = z.infer<typeof RunEventPageSchema>;

export const ApprovePlanRequestSchema = z.strictObject({}).describe("No fields.");

export const RejectPlanRequestSchema = z
  .strictObject({
    reason: z.string().trim().min(1).max(500).optional().describe("Shown in the run log."),
  })
  .describe("Why the plan is rejected.");
export type RejectPlanRequest = z.infer<typeof RejectPlanRequestSchema>;

export const PlanDecisionResultSchema = z
  .object({
    runId: z.uuid(),
    decision: z.enum(["approved", "rejected"]),
  })
  .describe("The recorded plan decision.");
export type PlanDecisionResult = z.infer<typeof PlanDecisionResultSchema>;

export const ArtifactListSchema = z
  .object({ data: z.array(ArtifactRefSchema) })
  .describe("The artifacts a run has produced so far.");
export type ArtifactList = z.infer<typeof ArtifactListSchema>;

export const AssistantSummarySchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    url: z.string().describe("The website the assistant was trained on."),
    status: z.enum(["draft", "ready"]),
    passRate: z.number().min(0).max(1).nullable().describe("Share of its own evals it passes."),
    pages: z.number().int().nonnegative(),
    runId: z.uuid().describe("The build-agent run that produced it."),
    createdAt: timestamp,
    webUrl: z.string(),
  })
  .describe("An assistant built by a build-agent run.");
export type AssistantSummary = z.infer<typeof AssistantSummarySchema>;

export const LIST_ASSISTANTS_MAX_LIMIT = 50;

export const ListAssistantsQuerySchema = z.strictObject({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(LIST_ASSISTANTS_MAX_LIMIT)
    .default(LIST_ASSISTANTS_MAX_LIMIT)
    .describe("How many of the most recent assistants to return."),
});
export type ListAssistantsQuery = z.input<typeof ListAssistantsQuerySchema>;

export const AssistantListSchema = z
  .object({ data: z.array(AssistantSummarySchema) })
  .describe("The workspace's assistants, newest first.");
export type AssistantList = z.infer<typeof AssistantListSchema>;

export const CHAT_QUESTION_MAX_CHARS = 1_000;
export const CHAT_HISTORY_MAX_TURNS = 12;

export const ChatTurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(4_000),
});
export type ChatTurn = z.infer<typeof ChatTurnSchema>;

export const ChatRequestSchema = z
  .strictObject({
    question: z.string().trim().min(1).max(CHAT_QUESTION_MAX_CHARS),
    history: z
      .array(ChatTurnSchema)
      .max(CHAT_HISTORY_MAX_TURNS)
      .default([])
      .describe("Earlier turns of this conversation, oldest first."),
  })
  .describe("A question for an assistant.");
export type ChatRequest = z.input<typeof ChatRequestSchema>;

export const CHAT_REFUSAL_REASONS = [
  "not_in_sources",
  "no_sources",
  "ungrounded",
  "rate_limited",
  "unavailable",
  "invalid_request",
] as const;

export const CitationSchema = z.object({
  index: z.number().int().describe("The [n] marker in the answer."),
  chunkId: z.string(),
  url: z.string(),
  title: z.string().optional(),
  quote: z.string().optional(),
});
export type Citation = z.infer<typeof CitationSchema>;

export const ChatAnswerSchema = z
  .object({
    answer: z.string(),
    citations: z.array(CitationSchema),
    grounded: z.boolean().describe("Every claim in the answer is backed by a cited passage."),
    refused: z.boolean(),
    refusal: z
      .object({ reason: z.enum(CHAT_REFUSAL_REASONS), message: z.string() })
      .nullable()
      .describe("Why the assistant declined, when refused is true."),
    servedBy: z.object({ provider: z.string(), model: z.string() }).nullable(),
    usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }),
    durationMs: z.number(),
  })
  .describe("An assistant's cited answer.");
export type ChatAnswer = z.infer<typeof ChatAnswerSchema>;

export const ChatStreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("delta"), text: z.string() }),
  CitationSchema.extend({ type: z.literal("citation") }),
  z.object({
    type: z.literal("refusal"),
    reason: z.enum(CHAT_REFUSAL_REASONS),
    message: z.string(),
    contactUrl: z.string().optional(),
    retryAfterMs: z.number().optional(),
  }),
  z.object({
    type: z.literal("done"),
    answer: z.string(),
    citations: z.array(CitationSchema),
    grounded: z.boolean(),
    refused: z.boolean(),
    servedBy: z.object({ provider: z.string(), model: z.string() }).optional(),
    usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }),
    durationMs: z.number(),
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type ChatStreamEvent = z.infer<typeof ChatStreamEventSchema>;

export const RunIdParamsSchema = z.strictObject({ runId: z.uuid() });
export const ArtifactParamsSchema = z.strictObject({
  runId: z.uuid(),
  artifactId: z.string().min(1).max(200),
});
export const AssistantIdParamsSchema = z.strictObject({ assistantId: z.uuid() });

export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key" as const;
export const IDEMPOTENCY_REPLAYED_HEADER = "Idempotent-Replayed" as const;
export const IDEMPOTENCY_KEY_MAX_CHARS = 255;
export const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

export const REQUEST_ID_HEADER = "X-Request-Id" as const;
export const RATE_LIMIT_HEADERS = {
  limit: "RateLimit-Limit",
  remaining: "RateLimit-Remaining",
  reset: "RateLimit-Reset",
} as const;

export const SSE_CONTROL_EVENTS = [
  "stream.replay",
  "stream.live",
  "stream.end",
  "stream.error",
] as const;
