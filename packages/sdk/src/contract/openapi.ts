import { z } from "zod";

import {
  API_ERROR_MEANINGS,
  API_ERROR_STATUS,
  type ApiErrorCode,
  ErrorEnvelopeSchema,
} from "./errors";
import {
  OPERATION_IDS,
  OPERATION_TAGS,
  OPERATIONS,
  type OperationSpec,
  operationErrors,
} from "./operations";
import {
  API_BASE_PATH,
  ApprovePlanRequestSchema,
  ArtifactListSchema,
  ArtifactRefSchema,
  ArtifactSchema,
  AssistantListSchema,
  AssistantSummarySchema,
  ChatAnswerSchema,
  ChatRequestSchema,
  ChatTurnSchema,
  CitationSchema,
  CreateRunRequestSchema,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_KEY_MAX_CHARS,
  IDEMPOTENCY_REPLAYED_HEADER,
  PlanDecisionResultSchema,
  RATE_LIMIT_HEADERS,
  REQUEST_ID_HEADER,
  RejectPlanRequestSchema,
  RunChildSchema,
  RunEventPageSchema,
  RunEventSchema,
  RunInputSchema,
  RunListSchema,
  RunSchema,
  RunStepSchema,
  RunSummarySchema,
} from "./schemas";
import {
  ApprovalRequestedWebhookSchema,
  RunCancelledWebhookSchema,
  RunCompletedWebhookSchema,
  RunFailedWebhookSchema,
  TestWebhookSchema,
  WEBHOOK_EVENT_MEANINGS,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_HEADERS,
  WEBHOOK_SIGNATURE_VERSION,
  WEBHOOK_TOLERANCE_SECONDS,
  WebhookApprovalSchema,
  type WebhookEventType,
  WebhookRunSchema,
} from "./webhooks";

export const OPENAPI_VERSION = "3.1.0" as const;
export const API_DOCUMENT_VERSION = "1.0.0" as const;

export const COMPONENT_SCHEMAS = {
  Error: ErrorEnvelopeSchema,
  RunInput: RunInputSchema,
  CreateRunRequest: CreateRunRequestSchema,
  RunStep: RunStepSchema,
  ArtifactRef: ArtifactRefSchema,
  Artifact: ArtifactSchema,
  RunChild: RunChildSchema,
  Run: RunSchema,
  RunSummary: RunSummarySchema,
  RunList: RunListSchema,
  RunEvent: RunEventSchema,
  RunEventPage: RunEventPageSchema,
  ApprovePlanRequest: ApprovePlanRequestSchema,
  RejectPlanRequest: RejectPlanRequestSchema,
  PlanDecisionResult: PlanDecisionResultSchema,
  ArtifactList: ArtifactListSchema,
  AssistantSummary: AssistantSummarySchema,
  AssistantList: AssistantListSchema,
  ChatTurn: ChatTurnSchema,
  ChatRequest: ChatRequestSchema,
  Citation: CitationSchema,
  ChatAnswer: ChatAnswerSchema,
  WebhookRun: WebhookRunSchema,
  WebhookApproval: WebhookApprovalSchema,
  RunCompletedWebhook: RunCompletedWebhookSchema,
  RunFailedWebhook: RunFailedWebhookSchema,
  RunCancelledWebhook: RunCancelledWebhookSchema,
  ApprovalRequestedWebhook: ApprovalRequestedWebhookSchema,
  TestWebhook: TestWebhookSchema,
} as const satisfies Record<string, z.ZodType>;

type ComponentName = keyof typeof COMPONENT_SCHEMAS;

const WEBHOOK_COMPONENTS: Record<WebhookEventType, ComponentName> = {
  "run.completed": "RunCompletedWebhook",
  "run.failed": "RunFailedWebhook",
  "run.cancelled": "RunCancelledWebhook",
  "approval.requested": "ApprovalRequestedWebhook",
};

type Json = Record<string, unknown>;

export interface OpenApiDocument {
  openapi: typeof OPENAPI_VERSION;
  info: Json;
  servers: Json[];
  tags: Json[];
  security: Json[];
  paths: Record<string, Record<string, Json>>;
  webhooks: Record<string, Record<string, Json>>;
  components: {
    securitySchemes: Json;
    parameters: Json;
    headers: Json;
    schemas: Record<string, Json>;
  };
}

const ref = (name: ComponentName): Json => ({ $ref: `#/components/schemas/${name}` });

function stripDialect(schema: Json): Json {
  return Object.fromEntries(
    Object.entries(schema).filter(([key]) => key !== "$schema" && key !== "$id"),
  );
}

function dropFormatPatterns(context: { jsonSchema: Json }): void {
  const json = context.jsonSchema;
  if (json.format === "date-time" || json.format === "uuid") delete json.pattern;
}

function componentSchemas(): Record<string, Json> {
  const registry = z.registry<{ id: string }>();
  for (const [name, schema] of Object.entries(COMPONENT_SCHEMAS))
    registry.add(schema, { id: name });
  const converted = z.toJSONSchema(registry, {
    uri: (id) => `#/components/schemas/${id}`,
    io: "input",
    override: dropFormatPatterns,
  });
  return Object.fromEntries(
    Object.entries(converted.schemas).map(([name, schema]) => [name, stripDialect(schema)]),
  );
}

function componentNameOf(schema: z.ZodType): ComponentName | undefined {
  return (Object.keys(COMPONENT_SCHEMAS) as ComponentName[]).find(
    (name) => COMPONENT_SCHEMAS[name] === schema,
  );
}

function inlineSchema(schema: z.ZodType): { schema: Json; description: string | undefined } {
  const { description, ...rest } = stripDialect(
    z.toJSONSchema(schema, { io: "input", override: dropFormatPatterns }),
  );
  return { schema: rest, description: typeof description === "string" ? description : undefined };
}

function schemaFor(schema: z.ZodType): Json {
  const name = componentNameOf(schema);
  return name === undefined ? inlineSchema(schema).schema : ref(name);
}

function parameters(shape: z.ZodObject | undefined, location: "path" | "query"): Json[] {
  if (shape === undefined) return [];
  const fields: Record<string, z.ZodType> = shape.shape;
  return Object.entries(fields).map(([name, field]) => {
    const { schema, description } = inlineSchema(field);
    return {
      name,
      in: location,
      required: location === "path" || !field.safeParse(undefined).success,
      ...(description === undefined ? {} : { description }),
      schema,
    };
  });
}

const RESPONSE_HEADERS = {
  [REQUEST_ID_HEADER]: { $ref: "#/components/headers/RequestId" },
  [RATE_LIMIT_HEADERS.limit]: { $ref: "#/components/headers/RateLimitLimit" },
  [RATE_LIMIT_HEADERS.remaining]: { $ref: "#/components/headers/RateLimitRemaining" },
  [RATE_LIMIT_HEADERS.reset]: { $ref: "#/components/headers/RateLimitReset" },
};

function errorResponses(spec: OperationSpec): Record<string, Json> {
  const byStatus = new Map<number, ApiErrorCode[]>();
  for (const code of operationErrors(spec)) {
    const status = API_ERROR_STATUS[code];
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  return Object.fromEntries(
    [...byStatus.entries()]
      .sort(([left], [right]) => left - right)
      .map(([status, codes]) => [
        String(status),
        {
          description: codes.map((code) => `\`${code}\`: ${API_ERROR_MEANINGS[code]}`).join("\n\n"),
          headers: {
            [REQUEST_ID_HEADER]: { $ref: "#/components/headers/RequestId" },
            ...(status === 429
              ? { "Retry-After": { $ref: "#/components/headers/RetryAfter" } }
              : {}),
          },
          content: { "application/json": { schema: ref("Error") } },
        },
      ]),
  );
}

function operationObject(id: string, spec: OperationSpec): Json {
  const body = spec.body;
  const success: Json = {
    description: spec.authenticated ? "Success." : "The document.",
    headers: {
      ...(spec.authenticated
        ? RESPONSE_HEADERS
        : { [REQUEST_ID_HEADER]: RESPONSE_HEADERS[REQUEST_ID_HEADER] }),
      ...(spec.idempotencyKey
        ? { [IDEMPOTENCY_REPLAYED_HEADER]: { $ref: "#/components/headers/IdempotentReplayed" } }
        : {}),
    },
    content: {
      "application/json": { schema: schemaFor(spec.response) },
      ...(spec.eventStream === null
        ? {}
        : { "text/event-stream": { schema: { type: "string", description: spec.eventStream } } }),
    },
  };
  return {
    operationId: id,
    tags: [spec.tag],
    summary: spec.summary,
    description: spec.description,
    security: spec.authenticated ? [{ bearerAuth: [] }] : [],
    parameters: [
      ...parameters(spec.params, "path"),
      ...parameters(spec.query, "query"),
      ...(spec.idempotencyKey ? [{ $ref: "#/components/parameters/IdempotencyKey" }] : []),
    ],
    ...(body === undefined
      ? {}
      : {
          requestBody: {
            required: spec.bodyRequired,
            content: { "application/json": { schema: schemaFor(body) } },
          },
        }),
    responses: {
      [String(spec.status)]: success,
      ...(spec.eventStream !== null && spec.method === "GET"
        ? {
            "204": {
              description:
                "Event stream only: the run is finished and no event follows the given position.",
            },
          }
        : {}),
      ...errorResponses(spec),
    },
  };
}

function webhookObject(type: WebhookEventType): Record<string, Json> {
  return {
    post: {
      operationId: `on${type
        .split(".")
        .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
        .join("")}`,
      tags: ["Webhooks"],
      summary: WEBHOOK_EVENT_MEANINGS[type],
      description:
        "Delivered to every endpoint of the workspace subscribed to this event. Verify the signature before trusting the body, answer with any 2xx within 10 seconds, and deduplicate on `id`: a delivery is retried until it is acknowledged.",
      security: [],
      parameters: [
        {
          name: WEBHOOK_HEADERS.timestamp,
          in: "header",
          required: true,
          description: `Unix time in seconds when this attempt was signed. Reject it when it is more than ${WEBHOOK_TOLERANCE_SECONDS} seconds from now.`,
          schema: { type: "string", pattern: "^[0-9]{1,12}$" },
        },
        {
          name: WEBHOOK_HEADERS.signature,
          in: "header",
          required: true,
          description: `\`${WEBHOOK_SIGNATURE_VERSION}=\` followed by the hex HMAC-SHA256, keyed with the endpoint secret, of the timestamp, a full stop and the raw request body. Several comma-separated values may be present; accept the delivery when any of them matches.`,
          schema: { type: "string" },
        },
        {
          name: WEBHOOK_HEADERS.delivery,
          in: "header",
          required: true,
          description: "The same value as `id` in the body.",
          schema: { type: "string", format: "uuid" },
        },
        {
          name: WEBHOOK_HEADERS.event,
          in: "header",
          required: true,
          description: "The same value as `type` in the body.",
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: true,
        content: { "application/json": { schema: ref(WEBHOOK_COMPONENTS[type]) } },
      },
      responses: {
        "2XX": { description: "Acknowledged; the delivery is not sent again." },
        default: { description: "Anything else, a redirect included, counts as a failure." },
      },
    },
  };
}

const INFO_DESCRIPTION = [
  "Run Delegate missions, follow them to their deliverable and talk to the assistants they build.",
  "**Authentication.** Send a workspace API token as `Authorization: Bearer dlg_…`. Tokens are created under Settings → Connections. Cookies are ignored on this API.",
  `**Errors.** Every non-2xx response is \`{ "error": { "code", "message", "requestId" } }\`. Branch on \`code\`; \`message\` is for people.`,
  `**Idempotency.** POST operations accept an \`${IDEMPOTENCY_KEY_HEADER}\` header. Repeating a request with the same key within 24 hours returns the first response with \`${IDEMPOTENCY_REPLAYED_HEADER}: true\` instead of acting again.`,
  `**Rate limits.** Every response reports the token's request budget in \`${RATE_LIMIT_HEADERS.limit}\`, \`${RATE_LIMIT_HEADERS.remaining}\` and \`${RATE_LIMIT_HEADERS.reset}\` (seconds until the window resets).`,
  "**Compatibility.** Within v1, fields and event types may be added; nothing is removed or renamed.",
].join("\n\n");

export function buildOpenApiDocument(options: { serverUrl?: string } = {}): OpenApiDocument {
  const paths: OpenApiDocument["paths"] = {};
  for (const id of OPERATION_IDS) {
    const spec: OperationSpec = OPERATIONS[id];
    const entry = (paths[spec.path] ??= {});
    entry[spec.method.toLowerCase()] = operationObject(id, spec);
  }
  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: "Delegate API",
      version: API_DOCUMENT_VERSION,
      summary: "Missions, runs, events, artifacts and assistants.",
      description: INFO_DESCRIPTION,
      license: { name: "MIT", identifier: "MIT" },
    },
    servers: [{ url: options.serverUrl ?? API_BASE_PATH }],
    tags: [
      ...OPERATION_TAGS.map((tag) => ({ ...tag })),
      { name: "Webhooks", description: "Signed deliveries Delegate sends to your endpoints." },
    ],
    security: [{ bearerAuth: [] }],
    paths,
    webhooks: Object.fromEntries(WEBHOOK_EVENT_TYPES.map((type) => [type, webhookObject(type)])),
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "A workspace API token (`dlg_…`).",
        },
      },
      parameters: {
        IdempotencyKey: {
          name: IDEMPOTENCY_KEY_HEADER,
          in: "header",
          required: false,
          description:
            "A unique value for this request, for example a UUID. A retry with the same key and the same request returns the first response.",
          schema: { type: "string", minLength: 1, maxLength: IDEMPOTENCY_KEY_MAX_CHARS },
        },
      },
      headers: {
        RequestId: {
          description: "Identifies this request in Delegate's logs.",
          schema: { type: "string" },
        },
        RateLimitLimit: {
          description: "Requests this token may make per window.",
          schema: { type: "integer" },
        },
        RateLimitRemaining: {
          description: "Requests left in the current window.",
          schema: { type: "integer" },
        },
        RateLimitReset: {
          description: "Seconds until the current window resets.",
          schema: { type: "integer" },
        },
        RetryAfter: {
          description: "Seconds to wait before trying again.",
          schema: { type: "integer" },
        },
        IdempotentReplayed: {
          description: "`true` when this is the stored response of an earlier request.",
          schema: { type: "string", enum: ["true"] },
        },
      },
      schemas: componentSchemas(),
    },
  };
}

export function openApiRoutes(document: Pick<OpenApiDocument, "paths">): string[] {
  return Object.entries(document.paths)
    .flatMap(([path, methods]) =>
      Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`),
    )
    .sort();
}
