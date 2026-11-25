import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";

import type { TenantTx } from "./client";

async function rowsOf<T extends z.ZodType>(row: T, tx: TenantTx, statement: SQL) {
  return z.object({ rows: z.array(row) }).parse(await tx.execute(statement)).rows;
}

async function onlyRow<T extends z.ZodType>(row: T, tx: TenantTx, statement: SQL) {
  const [first] = await rowsOf(row, tx, statement);
  if (first === undefined) throw new Error("expected one row, got none");
  return first;
}

const timestamp = z.union([z.date(), z.string()]).transform((value) => new Date(value));

export const IDEMPOTENCY_OUTCOMES = ["started", "replay", "mismatch", "in_progress"] as const;

export type IdempotencyBegin =
  | { outcome: "started" }
  | { outcome: "replay"; status: number; body: string }
  | { outcome: "mismatch" }
  | { outcome: "in_progress" };

const idempotencyScope = z.strictObject({
  workspaceId: z.uuid(),
  key: z.string().regex(/^[\x21-\x7e]{1,255}$/),
  requestHash: z.string().regex(/^[0-9a-f]{64}$/),
});

export const beginIdempotentRequestSchema = idempotencyScope.extend({
  lockSeconds: z.int().min(1).max(3600),
  ttlSeconds: z.int().min(60).max(604_800),
});
export type BeginIdempotentRequest = z.input<typeof beginIdempotentRequestSchema>;

const beginRow = z.object({
  outcome: z.enum(IDEMPOTENCY_OUTCOMES),
  stored_status: z.coerce.number().int().nullable(),
  stored_body: z.string().nullable(),
});

export async function beginIdempotentRequest(
  tx: TenantTx,
  input: BeginIdempotentRequest,
): Promise<IdempotencyBegin> {
  const request = beginIdempotentRequestSchema.parse(input);
  const row = await onlyRow(
    beginRow,
    tx,
    sql`select outcome, stored_status, stored_body from idempotency_begin(
      ${request.workspaceId}::uuid,
      ${request.key},
      ${request.requestHash},
      ${request.lockSeconds}::integer,
      ${request.ttlSeconds}::integer
    )`,
  );
  if (row.outcome !== "replay") return { outcome: row.outcome };
  if (row.stored_status === null || row.stored_body === null)
    throw new Error("a completed idempotency key has no stored response");
  return { outcome: "replay", status: row.stored_status, body: row.stored_body };
}

export const completeIdempotentRequestSchema = idempotencyScope.extend({
  status: z.int().min(200).max(299),
  body: z.string(),
});
export type CompleteIdempotentRequest = z.input<typeof completeIdempotentRequestSchema>;

export async function completeIdempotentRequest(
  tx: TenantTx,
  input: CompleteIdempotentRequest,
): Promise<boolean> {
  const request = completeIdempotentRequestSchema.parse(input);
  const row = await onlyRow(
    z.object({ completed: z.boolean() }),
    tx,
    sql`select idempotency_complete(
      ${request.workspaceId}::uuid,
      ${request.key},
      ${request.requestHash},
      ${request.status}::integer,
      ${request.body}
    ) as completed`,
  );
  return row.completed;
}

export async function releaseIdempotentRequest(
  tx: TenantTx,
  input: z.input<typeof idempotencyScope>,
): Promise<boolean> {
  const request = idempotencyScope.parse(input);
  const row = await onlyRow(
    z.object({ released: z.boolean() }),
    tx,
    sql`select idempotency_release(
      ${request.workspaceId}::uuid,
      ${request.key},
      ${request.requestHash}
    ) as released`,
  );
  return row.released;
}

const webhookData = z.record(z.string(), z.unknown());

export const enqueueWebhookDeliveriesSchema = z.strictObject({
  runId: z.uuid(),
  eventType: z.enum(["run.completed", "run.failed", "run.cancelled", "approval.requested"]),
  eventKey: z.string().min(1).max(200),
  data: webhookData,
});
export type EnqueueWebhookDeliveries = z.input<typeof enqueueWebhookDeliveriesSchema>;

export async function enqueueWebhookDeliveries(
  tx: TenantTx,
  input: EnqueueWebhookDeliveries,
): Promise<number> {
  const event = enqueueWebhookDeliveriesSchema.parse(input);
  const row = await onlyRow(
    z.object({ enqueued: z.coerce.number().int().nonnegative() }),
    tx,
    sql`select enqueue_webhook_deliveries(
      ${event.runId}::uuid,
      ${event.eventType},
      ${event.eventKey},
      ${JSON.stringify(event.data)}::jsonb
    ) as enqueued`,
  );
  return row.enqueued;
}

export async function enqueueWebhookTest(
  tx: TenantTx,
  input: { endpointId: string; data: Record<string, unknown> },
): Promise<string> {
  const endpointId = z.uuid().parse(input.endpointId);
  const row = await onlyRow(
    z.object({ delivery_id: z.uuid() }),
    tx,
    sql`select enqueue_webhook_test(
      ${endpointId}::uuid,
      ${JSON.stringify(webhookData.parse(input.data))}::jsonb
    ) as delivery_id`,
  );
  return row.delivery_id;
}

export interface ClaimedWebhookDelivery {
  deliveryId: string;
  endpointId: string;
  url: string;
  origin: string;
  secretCiphertext: string;
  eventType: string;
  data: Record<string, unknown>;
  attempt: number;
  createdAt: Date;
}

export const claimWebhookDeliveriesSchema = z.strictObject({
  workspaceId: z.uuid(),
  limit: z.int().min(1).max(50),
  leaseSeconds: z.int().min(5).max(600),
  maxAttempts: z.int().min(1).max(20),
  deliveryId: z.uuid().optional(),
});
export type ClaimWebhookDeliveries = z.input<typeof claimWebhookDeliveriesSchema>;

const claimedRow = z.object({
  delivery_id: z.uuid(),
  endpoint_id: z.uuid(),
  endpoint_url: z.string(),
  endpoint_origin: z.string(),
  secret_ciphertext: z.string(),
  event_type: z.string(),
  data: webhookData,
  attempt: z.coerce.number().int().positive(),
  created_at: timestamp,
});

export async function claimWebhookDeliveries(
  tx: TenantTx,
  input: ClaimWebhookDeliveries,
): Promise<ClaimedWebhookDelivery[]> {
  const claim = claimWebhookDeliveriesSchema.parse(input);
  const rows = await rowsOf(
    claimedRow,
    tx,
    sql`select delivery_id, endpoint_id, endpoint_url, endpoint_origin, secret_ciphertext,
        event_type, data, attempt, created_at
      from claim_webhook_deliveries(
        ${claim.workspaceId}::uuid,
        ${claim.limit}::integer,
        ${claim.leaseSeconds}::integer,
        ${claim.maxAttempts}::integer,
        ${claim.deliveryId ?? null}::uuid
      )`,
  );
  return rows.map((row) => ({
    deliveryId: row.delivery_id,
    endpointId: row.endpoint_id,
    url: row.endpoint_url,
    origin: row.endpoint_origin,
    secretCiphertext: row.secret_ciphertext,
    eventType: row.event_type,
    data: row.data,
    attempt: row.attempt,
    createdAt: row.created_at,
  }));
}

export const settleWebhookDeliverySchema = z
  .strictObject({
    deliveryId: z.uuid(),
    attempt: z.int().positive(),
    outcome: z.enum(["delivered", "retry", "failed"]),
    statusCode: z.int().min(100).max(599).nullable().default(null),
    error: z.string().max(60).nullable().default(null),
    excerpt: z.string().nullable().default(null),
    nextAttemptAt: z.date().nullable().default(null),
  })
  .refine((settle) => (settle.outcome === "retry") === (settle.nextAttemptAt !== null), {
    error: "A retry, and only a retry, needs a next attempt time",
  });
export type SettleWebhookDelivery = z.input<typeof settleWebhookDeliverySchema>;

export async function settleWebhookDelivery(
  tx: TenantTx,
  input: SettleWebhookDelivery,
): Promise<boolean> {
  const settle = settleWebhookDeliverySchema.parse(input);
  const row = await onlyRow(
    z.object({ settled: z.boolean() }),
    tx,
    sql`select settle_webhook_delivery(
      ${settle.deliveryId}::uuid,
      ${settle.attempt}::integer,
      ${settle.outcome},
      ${settle.statusCode}::integer,
      ${settle.error},
      ${settle.excerpt},
      ${settle.nextAttemptAt === null ? null : settle.nextAttemptAt.toISOString()}::timestamptz
    ) as settled`,
  );
  return row.settled;
}
