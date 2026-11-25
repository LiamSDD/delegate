import { z } from "zod";

import { API_VERSION, RunErrorSchema, RunStatusSchema } from "./schemas";

export const WEBHOOK_EVENT_TYPES = [
  "run.completed",
  "run.failed",
  "run.cancelled",
  "approval.requested",
] as const;
export const WebhookEventTypeSchema = z.enum(WEBHOOK_EVENT_TYPES);
export type WebhookEventType = z.infer<typeof WebhookEventTypeSchema>;

export const WEBHOOK_TEST_EVENT_TYPE = "webhook.test" as const;

export const WEBHOOK_EVENT_MEANINGS: Record<WebhookEventType, string> = {
  "run.completed": "A run finished and its deliverable is ready.",
  "run.failed": "A run stopped with an error.",
  "run.cancelled": "A run was cancelled by a user or through the API.",
  "approval.requested":
    "A run is waiting for a human decision: a plan, a connector tool call or a pull request.",
};

export const WEBHOOK_HEADERS = {
  timestamp: "delegate-timestamp",
  signature: "delegate-signature",
  delivery: "delegate-delivery",
  event: "delegate-event",
} as const;

export const WEBHOOK_SIGNATURE_VERSION = "v1" as const;
export const WEBHOOK_TOLERANCE_SECONDS = 300;
export const WEBHOOK_SECRET_PREFIX = "dlgwh_" as const;

const timestamp = z.iso.datetime();

export const WebhookRunSchema = z
  .object({
    id: z.uuid(),
    mission: z.string(),
    target: z.string().nullable(),
    status: RunStatusSchema,
    createdAt: timestamp,
    startedAt: timestamp.nullable(),
    finishedAt: timestamp.nullable(),
    summary: z.string().nullable(),
    error: RunErrorSchema.nullable(),
    totals: z.object({
      inputTokens: z.number(),
      outputTokens: z.number(),
      costMicroUsd: z.number(),
    }),
    url: z.string().describe("The run in the web app."),
  })
  .describe("The run a delivery is about, as it was when the event happened.");
export type WebhookRun = z.infer<typeof WebhookRunSchema>;

export const WEBHOOK_APPROVAL_KINDS = ["plan", "tool", "ship"] as const;

export const WebhookApprovalSchema = z
  .object({
    id: z.string(),
    kind: z
      .enum(WEBHOOK_APPROVAL_KINDS)
      .describe(
        "`plan` can be decided through the API; `tool` and `ship` are decided in the web app.",
      ),
    summary: z.string(),
    url: z.string().describe("Where a person decides it."),
  })
  .describe("The decision a run is waiting for.");
export type WebhookApproval = z.infer<typeof WebhookApprovalSchema>;

const envelope = {
  id: z.uuid().describe("Unique per endpoint and event; the same on every retry."),
  created: timestamp.describe("When the event happened."),
  apiVersion: z.literal(API_VERSION),
};

export const RunWebhookDataSchema = z.object({ run: WebhookRunSchema });
export const ApprovalWebhookDataSchema = z.object({
  run: WebhookRunSchema,
  approval: WebhookApprovalSchema,
});
export const TestWebhookDataSchema = z.object({ message: z.string() });

export const RunCompletedWebhookSchema = z
  .object({ ...envelope, type: z.literal("run.completed"), data: RunWebhookDataSchema })
  .describe(WEBHOOK_EVENT_MEANINGS["run.completed"]);
export const RunFailedWebhookSchema = z
  .object({ ...envelope, type: z.literal("run.failed"), data: RunWebhookDataSchema })
  .describe(WEBHOOK_EVENT_MEANINGS["run.failed"]);
export const RunCancelledWebhookSchema = z
  .object({ ...envelope, type: z.literal("run.cancelled"), data: RunWebhookDataSchema })
  .describe(WEBHOOK_EVENT_MEANINGS["run.cancelled"]);
export const ApprovalRequestedWebhookSchema = z
  .object({ ...envelope, type: z.literal("approval.requested"), data: ApprovalWebhookDataSchema })
  .describe(WEBHOOK_EVENT_MEANINGS["approval.requested"]);
export const TestWebhookSchema = z
  .object({ ...envelope, type: z.literal(WEBHOOK_TEST_EVENT_TYPE), data: TestWebhookDataSchema })
  .describe("Sent from the settings page to check an endpoint.");

export const WebhookEventSchema = z.discriminatedUnion("type", [
  RunCompletedWebhookSchema,
  RunFailedWebhookSchema,
  RunCancelledWebhookSchema,
  ApprovalRequestedWebhookSchema,
  TestWebhookSchema,
]);
export type WebhookEvent = z.infer<typeof WebhookEventSchema>;

export const UnknownWebhookEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  created: z.string(),
  apiVersion: z.string(),
  data: z.unknown(),
});
export type UnknownWebhookEvent = z.infer<typeof UnknownWebhookEventSchema>;

export const WEBHOOK_SCHEMAS: Record<WebhookEventType, z.ZodType> = {
  "run.completed": RunCompletedWebhookSchema,
  "run.failed": RunFailedWebhookSchema,
  "run.cancelled": RunCancelledWebhookSchema,
  "approval.requested": ApprovalRequestedWebhookSchema,
};
