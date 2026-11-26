import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { admins, currentUserId, definerPolicies, tenantPolicies } from "./rls";
import { runs } from "./runs";
import { users, workspaces } from "./tenancy";

export const WEBHOOK_EVENT_TYPES = [
  "run.completed",
  "run.failed",
  "run.cancelled",
  "approval.requested",
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export const WEBHOOK_TEST_EVENT_TYPE = "webhook.test" as const;

export const WEBHOOK_DELIVERY_STATUSES = ["pending", "delivered", "failed"] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

export const WEBHOOK_EXCERPT_MAX_CHARS = 200;
export const WEBHOOK_ERROR_MAX_CHARS = 60;
export const WEBHOOK_ATTEMPTS_CEILING = 20;
export const IDEMPOTENCY_RESPONSE_MAX_BYTES = 256 * 1024;

const quoted = (values: readonly string[]) =>
  sql.raw(values.map((value) => `'${value}'`).join(", "));

export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by")
      .default(currentUserId)
      .references(() => users.id, { onDelete: "set null" }),
    url: text("url").notNull(),
    origin: text("origin").notNull(),
    description: text("description").notNull().default(""),
    events: text("events").array().notNull(),
    secretCiphertext: text("secret_ciphertext").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    secretRotatedAt: timestamp("secret_rotated_at", { withTimezone: true }),
  },
  (t) => [
    unique("webhook_endpoints_id_workspace_unique").on(t.id, t.workspaceId),
    unique("webhook_endpoints_workspace_url_unique").on(t.workspaceId, t.url),
    check(
      "webhook_endpoints_url_https",
      sql`${t.url} ~ '^https://' and char_length(${t.url}) <= 2048`,
    ),
    check(
      "webhook_endpoints_origin_format",
      sql`${t.origin} ~ '^https?://[^/]+$' and char_length(${t.origin}) <= 300`,
    ),
    check("webhook_endpoints_description_length", sql`char_length(${t.description}) <= 120`),
    check(
      "webhook_endpoints_events_known",
      sql`cardinality(${t.events}) between 1 and ${sql.raw(String(WEBHOOK_EVENT_TYPES.length))} and ${t.events} <@ array[${quoted(WEBHOOK_EVENT_TYPES)}]::text[]`,
    ),
    ...tenantPolicies(
      "webhook_endpoints",
      t.workspaceId,
      { select: admins, insert: admins, update: admins, delete: admins },
      sql`${t.createdBy} = ${currentUserId}`,
    ),
    ...definerPolicies("webhook_endpoints", ["select"]),
  ],
).enableRLS();

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    endpointId: uuid("endpoint_id").notNull(),
    runId: uuid("run_id"),
    eventType: text("event_type").notNull(),
    eventKey: text("event_key").notNull(),
    data: jsonb("data").$type<unknown>().notNull(),
    status: text("status").$type<WebhookDeliveryStatus>().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastStatusCode: integer("last_status_code"),
    lastError: text("last_error"),
    lastResponseExcerpt: text("last_response_excerpt"),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "webhook_deliveries_endpoint_fk",
      columns: [t.endpointId, t.workspaceId],
      foreignColumns: [webhookEndpoints.id, webhookEndpoints.workspaceId],
    }).onDelete("cascade"),
    foreignKey({
      name: "webhook_deliveries_run_fk",
      columns: [t.runId, t.workspaceId],
      foreignColumns: [runs.id, runs.workspaceId],
    }).onDelete("cascade"),
    unique("webhook_deliveries_endpoint_event_unique").on(t.endpointId, t.eventKey),
    index("webhook_deliveries_due_idx").on(t.workspaceId, t.status, t.nextAttemptAt),
    index("webhook_deliveries_endpoint_created_idx").on(t.endpointId, t.createdAt),
    check(
      "webhook_deliveries_status_known",
      sql`${t.status} in (${quoted(WEBHOOK_DELIVERY_STATUSES)})`,
    ),
    check(
      "webhook_deliveries_event_type_known",
      sql`${t.eventType} in (${quoted([...WEBHOOK_EVENT_TYPES, WEBHOOK_TEST_EVENT_TYPE])})`,
    ),
    check("webhook_deliveries_event_key_length", sql`char_length(${t.eventKey}) between 1 and 200`),
    check(
      "webhook_deliveries_attempts_bounded",
      sql`${t.attempts} between 0 and ${sql.raw(String(WEBHOOK_ATTEMPTS_CEILING))}`,
    ),
    check(
      "webhook_deliveries_pending_has_next_attempt",
      sql`(${t.status} = 'pending') = (${t.nextAttemptAt} is not null)`,
    ),
    check(
      "webhook_deliveries_delivered_consistent",
      sql`(${t.status} = 'delivered') = (${t.deliveredAt} is not null)`,
    ),
    check(
      "webhook_deliveries_status_code_range",
      sql`${t.lastStatusCode} is null or ${t.lastStatusCode} between 100 and 599`,
    ),
    check(
      "webhook_deliveries_error_short",
      sql`${t.lastError} is null or char_length(${t.lastError}) <= ${sql.raw(String(WEBHOOK_ERROR_MAX_CHARS))}`,
    ),
    check(
      "webhook_deliveries_excerpt_short",
      sql`${t.lastResponseExcerpt} is null or char_length(${t.lastResponseExcerpt}) <= ${sql.raw(String(WEBHOOK_EXCERPT_MAX_CHARS))}`,
    ),
    check("webhook_deliveries_data_is_object", sql`jsonb_typeof(${t.data}) = 'object'`),
    ...tenantPolicies("webhook_deliveries", t.workspaceId, { select: admins }),
    ...definerPolicies("webhook_deliveries", ["select", "insert", "update", "delete"]),
  ],
).enableRLS();

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    status: text("status").$type<"in_progress" | "completed">().notNull().default("in_progress"),
    responseStatus: integer("response_status"),
    responseBody: text("response_body"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ name: "idempotency_keys_pk", columns: [t.workspaceId, t.key] }),
    index("idempotency_keys_expiry_idx").on(t.workspaceId, t.expiresAt),
    check("idempotency_keys_key_format", sql`${t.key} ~ '^[!-~]{1,255}$'`),
    check("idempotency_keys_hash_format", sql`${t.requestHash} ~ '^[0-9a-f]{64}$'`),
    check("idempotency_keys_status_known", sql`${t.status} in ('in_progress', 'completed')`),
    check(
      "idempotency_keys_completed_has_response",
      sql`(${t.status} = 'completed') = (${t.responseStatus} is not null and ${t.responseBody} is not null)`,
    ),
    check(
      "idempotency_keys_response_is_success",
      sql`${t.responseStatus} is null or ${t.responseStatus} between 200 and 299`,
    ),
    check(
      "idempotency_keys_response_size",
      sql`${t.responseBody} is null or octet_length(${t.responseBody}) <= ${sql.raw(String(IDEMPOTENCY_RESPONSE_MAX_BYTES))}`,
    ),
    ...definerPolicies("idempotency_keys", ["select", "insert", "update", "delete"]),
  ],
).enableRLS();
