import { z } from "zod";

import { type ApiErrorCode } from "./errors";
import {
  API_BASE_PATH,
  ApprovePlanRequestSchema,
  ArtifactListSchema,
  ArtifactParamsSchema,
  ArtifactSchema,
  AssistantIdParamsSchema,
  AssistantListSchema,
  ChatAnswerSchema,
  ChatRequestSchema,
  CreateRunRequestSchema,
  ListAssistantsQuerySchema,
  ListRunEventsQuerySchema,
  ListRunsQuerySchema,
  MISSION_IDS,
  MISSION_INPUT_RULES,
  PlanDecisionResultSchema,
  RejectPlanRequestSchema,
  RunEventPageSchema,
  RunIdParamsSchema,
  RunListSchema,
  RunSchema,
} from "./schemas";

export type HttpMethod = "GET" | "POST";

export const OPERATION_TAGS = [
  { name: "Runs", description: "Start missions and follow them to their deliverable." },
  { name: "Events", description: "The append-only log every run view is derived from." },
  { name: "Plans", description: "Decide the plan a run proposes before it starts working." },
  { name: "Artifacts", description: "Deliverables, source snapshots and intermediate results." },
  { name: "Assistants", description: "Assistants built by build-agent runs." },
  { name: "Meta", description: "This document." },
] as const;
export type OperationTag = (typeof OPERATION_TAGS)[number]["name"];

export interface OperationSpec<
  Params extends z.ZodObject | undefined = z.ZodObject | undefined,
  Query extends z.ZodObject | undefined = z.ZodObject | undefined,
  Body extends z.ZodType | undefined = z.ZodType | undefined,
  Result extends z.ZodType = z.ZodType,
> {
  method: HttpMethod;
  path: string;
  tag: OperationTag;
  summary: string;
  description: string;
  params: Params;
  query: Query;
  body: Body;
  bodyRequired: boolean;
  maxBodyBytes: number;
  response: Result;
  status: 200 | 201;
  errors: readonly ApiErrorCode[];
  authenticated: boolean;
  idempotencyKey: boolean;
  eventStream: string | null;
}

function operation<
  Params extends z.ZodObject | undefined,
  Query extends z.ZodObject | undefined,
  Body extends z.ZodType | undefined,
  Result extends z.ZodType,
>(spec: OperationSpec<Params, Query, Body, Result>): OperationSpec<Params, Query, Body, Result> {
  return spec;
}

const SMALL_BODY_BYTES = 8 * 1024;
const CHAT_BODY_BYTES = 64 * 1024;

const missionTable = MISSION_IDS.map((id) => {
  const rule = MISSION_INPUT_RULES[id];
  const optional = rule.optional.length === 0 ? "" : `; optional ${rule.optional.join(", ")}`;
  const parent = rule.acceptsParentRun ? "; takes parentRunId" : "";
  return `- \`${id}\` (${rule.title}): needs ${rule.required.join(", ")}${optional}${parent}`;
}).join("\n");

export const OpenApiDocumentSchema = z
  .record(z.string(), z.unknown())
  .describe("An OpenAPI 3.1 document.");

export const OPERATIONS = {
  createRun: operation({
    method: "POST",
    path: "/runs",
    tag: "Runs",
    summary: "Start a run",
    description: `Starts a mission. The run begins planning at once and, unless the workspace approves plans automatically, then waits for its plan to be approved.\n\n${missionTable}\n\nRuns count against the workspace's hourly run quota; when it is used up the answer is 429 with Retry-After.`,
    params: undefined,
    query: undefined,
    body: CreateRunRequestSchema,
    bodyRequired: true,
    maxBodyBytes: SMALL_BODY_BYTES,
    response: RunSchema,
    status: 201,
    errors: ["invalid_request", "invalid_json", "invalid_url", "unsupported_media_type"],
    authenticated: true,
    idempotencyKey: true,
    eventStream: null,
  }),
  listRuns: operation({
    method: "GET",
    path: "/runs",
    tag: "Runs",
    summary: "List runs",
    description:
      "The workspace's runs, newest first. Follow nextCursor until it is null to read them all.",
    params: undefined,
    query: ListRunsQuerySchema,
    body: undefined,
    bodyRequired: false,
    maxBodyBytes: 0,
    response: RunListSchema,
    status: 200,
    errors: ["invalid_request"],
    authenticated: true,
    idempotencyKey: false,
    eventStream: null,
  }),
  getRun: operation({
    method: "GET",
    path: "/runs/{runId}",
    tag: "Runs",
    summary: "Get a run",
    description:
      "Status, steps, artifacts, the plan or approvals it is waiting for and, once it completed, the deliverable. An Autopilot run also lists its child runs.",
    params: RunIdParamsSchema,
    query: undefined,
    body: undefined,
    bodyRequired: false,
    maxBodyBytes: 0,
    response: RunSchema,
    status: 200,
    errors: ["not_found"],
    authenticated: true,
    idempotencyKey: false,
    eventStream: null,
  }),
  cancelRun: operation({
    method: "POST",
    path: "/runs/{runId}/cancel",
    tag: "Runs",
    summary: "Cancel a run",
    description:
      "Stops a run that has not finished. The run ends as `failed` with error code `cancelled`; an Autopilot run also cancels its open children.",
    params: RunIdParamsSchema,
    query: undefined,
    body: undefined,
    bodyRequired: false,
    maxBodyBytes: SMALL_BODY_BYTES,
    response: RunSchema,
    status: 200,
    errors: ["not_found", "run_finished"],
    authenticated: true,
    idempotencyKey: true,
    eventStream: null,
  }),
  listRunEvents: operation({
    method: "GET",
    path: "/runs/{runId}/events",
    tag: "Events",
    summary: "Read a run's events",
    description:
      "JSON by default: pages in sequence order, continued with `after`. Poll until `terminal` is true and `hasMore` is false.",
    params: RunIdParamsSchema,
    query: ListRunEventsQuerySchema,
    body: undefined,
    bodyRequired: false,
    maxBodyBytes: 0,
    response: RunEventPageSchema,
    status: 200,
    errors: ["invalid_request", "not_found"],
    authenticated: true,
    idempotencyKey: false,
    eventStream:
      "Sent when the request has `Accept: text/event-stream`. Stored events after `after` (or the `Last-Event-ID` header) are replayed, then new ones follow live. Each run event is one message: `id` is its sequence, `event` its type and `data` the RunEvent as JSON. Control messages: `stream.replay` (how many stored events follow), `stream.live`, `stream.end` (the run is finished) and `stream.error`. The stream closes after the terminal event or when the server's time limit is reached; reconnect with the last sequence. A finished run with nothing after `after` answers 204.",
  }),
  approvePlan: operation({
    method: "POST",
    path: "/runs/{runId}/plan/approve",
    tag: "Plans",
    summary: "Approve the proposed plan",
    description:
      "Approves the plan as proposed, so the run starts working. Editing a plan before approving it is done in the web app.",
    params: RunIdParamsSchema,
    query: undefined,
    body: ApprovePlanRequestSchema,
    bodyRequired: false,
    maxBodyBytes: SMALL_BODY_BYTES,
    response: PlanDecisionResultSchema,
    status: 200,
    errors: [
      "invalid_request",
      "invalid_json",
      "unsupported_media_type",
      "forbidden",
      "not_found",
      "run_finished",
      "no_pending_plan",
    ],
    authenticated: true,
    idempotencyKey: true,
    eventStream: null,
  }),
  rejectPlan: operation({
    method: "POST",
    path: "/runs/{runId}/plan/reject",
    tag: "Plans",
    summary: "Reject the proposed plan",
    description: "Rejects the plan; the run stops as failed with error code `plan_rejected`.",
    params: RunIdParamsSchema,
    query: undefined,
    body: RejectPlanRequestSchema,
    bodyRequired: false,
    maxBodyBytes: SMALL_BODY_BYTES,
    response: PlanDecisionResultSchema,
    status: 200,
    errors: [
      "invalid_request",
      "invalid_json",
      "unsupported_media_type",
      "forbidden",
      "not_found",
      "run_finished",
      "no_pending_plan",
    ],
    authenticated: true,
    idempotencyKey: true,
    eventStream: null,
  }),
  listArtifacts: operation({
    method: "GET",
    path: "/runs/{runId}/artifacts",
    tag: "Artifacts",
    summary: "List a run's artifacts",
    description: "References to everything the run has produced so far, without content.",
    params: RunIdParamsSchema,
    query: undefined,
    body: undefined,
    bodyRequired: false,
    maxBodyBytes: 0,
    response: ArtifactListSchema,
    status: 200,
    errors: ["not_found"],
    authenticated: true,
    idempotencyKey: false,
    eventStream: null,
  }),
  getArtifact: operation({
    method: "GET",
    path: "/runs/{runId}/artifacts/{artifactId}",
    tag: "Artifacts",
    summary: "Get an artifact",
    description: "One artifact with its content, at its latest version.",
    params: ArtifactParamsSchema,
    query: undefined,
    body: undefined,
    bodyRequired: false,
    maxBodyBytes: 0,
    response: ArtifactSchema,
    status: 200,
    errors: ["invalid_request", "not_found"],
    authenticated: true,
    idempotencyKey: false,
    eventStream: null,
  }),
  listAssistants: operation({
    method: "GET",
    path: "/assistants",
    tag: "Assistants",
    summary: "List assistants",
    description: "The assistants this workspace has built, newest first.",
    params: undefined,
    query: ListAssistantsQuerySchema,
    body: undefined,
    bodyRequired: false,
    maxBodyBytes: 0,
    response: AssistantListSchema,
    status: 200,
    errors: ["invalid_request"],
    authenticated: true,
    idempotencyKey: false,
    eventStream: null,
  }),
  chatWithAssistant: operation({
    method: "POST",
    path: "/assistants/{assistantId}/chat",
    tag: "Assistants",
    summary: "Ask an assistant",
    description:
      "Answers one question from the assistant's sources, with citations. Nothing is stored between calls: send earlier turns in `history`. Questions count against the workspace's hourly question quota.",
    params: AssistantIdParamsSchema,
    query: undefined,
    body: ChatRequestSchema,
    bodyRequired: true,
    maxBodyBytes: CHAT_BODY_BYTES,
    response: ChatAnswerSchema,
    status: 200,
    errors: [
      "invalid_request",
      "invalid_json",
      "unsupported_media_type",
      "payload_too_large",
      "not_found",
      "unavailable",
    ],
    authenticated: true,
    idempotencyKey: true,
    eventStream:
      "Sent when the request has `Accept: text/event-stream`: `delta` messages with answer text, `citation` messages, an optional `refusal`, then `done` with the full answer. Idempotency-Key cannot be combined with a streamed answer.",
  }),
  getOpenApi: operation({
    method: "GET",
    path: "/openapi.json",
    tag: "Meta",
    summary: "This OpenAPI document",
    description: "Generated from the same schemas the server validates with. No token needed.",
    params: undefined,
    query: undefined,
    body: undefined,
    bodyRequired: false,
    maxBodyBytes: 0,
    response: OpenApiDocumentSchema,
    status: 200,
    errors: [],
    authenticated: false,
    idempotencyKey: false,
    eventStream: null,
  }),
} as const;

export type OperationId = keyof typeof OPERATIONS;
export const OPERATION_IDS = Object.keys(OPERATIONS) as OperationId[];

type SchemaOutput<T> = T extends z.ZodType ? z.output<T> : undefined;
type SchemaInput<T> = T extends z.ZodType ? z.input<T> : undefined;

export type OperationParams<Id extends OperationId> = SchemaOutput<
  (typeof OPERATIONS)[Id]["params"]
>;
export type OperationQuery<Id extends OperationId> = SchemaOutput<(typeof OPERATIONS)[Id]["query"]>;
export type OperationQueryInput<Id extends OperationId> = SchemaInput<
  (typeof OPERATIONS)[Id]["query"]
>;
export type OperationBody<Id extends OperationId> = SchemaOutput<(typeof OPERATIONS)[Id]["body"]>;
export type OperationBodyInput<Id extends OperationId> = SchemaInput<
  (typeof OPERATIONS)[Id]["body"]
>;
export type OperationResponse<Id extends OperationId> = z.output<
  (typeof OPERATIONS)[Id]["response"]
>;

export const COMMON_ERRORS: readonly ApiErrorCode[] = ["unauthorized", "rate_limited", "internal"];
export const IDEMPOTENCY_ERRORS: readonly ApiErrorCode[] = [
  "invalid_idempotency_key",
  "idempotency_in_progress",
  "idempotency_key_reused",
];

export function operationErrors(spec: OperationSpec): ApiErrorCode[] {
  return [
    ...new Set<ApiErrorCode>([
      ...spec.errors,
      ...(spec.authenticated ? COMMON_ERRORS : []),
      ...(spec.idempotencyKey ? IDEMPOTENCY_ERRORS : []),
    ]),
  ];
}

export function operationPath(
  spec: Pick<OperationSpec, "path">,
  params: Record<string, string> | undefined,
): string {
  const path = spec.path.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = params?.[name];
    if (value === undefined || value === "") throw new Error(`Missing path parameter ${name}`);
    return encodeURIComponent(value);
  });
  return `${API_BASE_PATH}${path}`;
}
