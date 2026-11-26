import {
  type ClaimedWebhookDelivery,
  claimWebhookDeliveries,
  settleWebhookDelivery,
  type SettleWebhookDelivery,
  withTenant,
} from "@delegate/db";
import { signWebhookPayload } from "@delegate/sdk/webhooks";
import { WEBHOOK_HEADERS } from "@delegate/sdk/contract";

import { REPO_URL } from "@/lib/site";

import type { AppDatabase } from "../db";
import { SecretStoreError } from "../secrets";
import { renderWebhookBody } from "./payload";
import {
  maxAttemptsFor,
  planRetry,
  WEBHOOK_BATCH_SIZE,
  WEBHOOK_FLUSH_THROTTLE_MS,
  WEBHOOK_LEASE_SECONDS,
  WEBHOOK_MAX_ATTEMPTS,
} from "./policy";
import { type WebhookRuntime, webhookRuntime } from "./runtime";
import type { WebhookSendOutcome } from "./transport";

export const WEBHOOK_USER_AGENT = `Delegate-Webhooks/1.0 (+${REPO_URL})`;

export const DELIVERY_ERRORS = [
  "http_error",
  "redirect",
  "timeout",
  "network",
  "blocked",
  "encryption_key_missing",
  "secret_unreadable",
  "invalid_payload",
  "abandoned",
] as const;
export type DeliveryError = (typeof DELIVERY_ERRORS)[number];

export interface FlushScope {
  workspaceId: string;
  userId: string;
}

export interface FlushResult {
  claimed: number;
  delivered: number;
  retrying: number;
  failed: number;
}

type Attempt =
  | { ok: true; statusCode: number; excerpt: string }
  | {
      ok: false;
      error: DeliveryError;
      statusCode: number | null;
      excerpt: string | null;
      retryAfterMs: number | null;
      permanent: boolean;
    };

function failure(error: DeliveryError, permanent = false): Extract<Attempt, { ok: false }> {
  return { ok: false, error, statusCode: null, excerpt: null, retryAfterMs: null, permanent };
}

function fromOutcome(outcome: WebhookSendOutcome): Attempt {
  switch (outcome.kind) {
    case "response":
      if (outcome.status >= 200 && outcome.status < 300)
        return { ok: true, statusCode: outcome.status, excerpt: outcome.excerpt };
      return {
        ok: false,
        error: outcome.status >= 300 && outcome.status < 400 ? "redirect" : "http_error",
        statusCode: outcome.status,
        excerpt: outcome.excerpt,
        retryAfterMs: outcome.retryAfterMs,
        permanent: false,
      };
    case "blocked":
      return failure("blocked");
    case "timeout":
      return failure("timeout");
    case "network":
      return failure("network");
  }
}

async function attempt(
  delivery: ClaimedWebhookDelivery,
  runtime: WebhookRuntime,
): Promise<Attempt> {
  const box = runtime.box();
  if (box === null) return failure("encryption_key_missing");
  let secret: string;
  try {
    secret = box.open(delivery.secretCiphertext, delivery.endpointId);
  } catch (error) {
    if (error instanceof SecretStoreError) return failure("secret_unreadable");
    throw error;
  }
  let body: string;
  try {
    body = renderWebhookBody(delivery);
  } catch {
    return failure("invalid_payload", true);
  }
  const timestamp = Math.floor(runtime.now().getTime() / 1000);
  return fromOutcome(
    await runtime.transport({
      url: delivery.url,
      body,
      headers: {
        "content-type": "application/json",
        "user-agent": WEBHOOK_USER_AGENT,
        [WEBHOOK_HEADERS.event]: delivery.eventType,
        [WEBHOOK_HEADERS.delivery]: delivery.deliveryId,
        [WEBHOOK_HEADERS.timestamp]: String(timestamp),
        [WEBHOOK_HEADERS.signature]: await signWebhookPayload(secret, timestamp, body),
      },
    }),
  );
}

function settlement(
  delivery: ClaimedWebhookDelivery,
  result: Attempt,
  now: Date,
): SettleWebhookDelivery {
  const base = { deliveryId: delivery.deliveryId, attempt: delivery.attempt };
  if (result.ok)
    return {
      ...base,
      outcome: "delivered",
      statusCode: result.statusCode,
      excerpt: result.excerpt,
    };
  const details = { statusCode: result.statusCode, error: result.error, excerpt: result.excerpt };
  const plan = result.permanent
    ? ({ outcome: "failed" } as const)
    : planRetry({
        attemptsMade: delivery.attempt,
        maxAttempts: maxAttemptsFor(delivery.eventType),
        now,
        retryAfterMs: result.retryAfterMs,
      });
  return plan.outcome === "retry"
    ? { ...base, ...details, outcome: "retry", nextAttemptAt: plan.nextAttemptAt }
    : { ...base, ...details, outcome: "failed" };
}

async function deliver(
  app: AppDatabase,
  scope: FlushScope,
  delivery: ClaimedWebhookDelivery,
  runtime: WebhookRuntime,
): Promise<SettleWebhookDelivery["outcome"] | null> {
  let result: Attempt;
  try {
    result = await attempt(delivery, runtime);
  } catch (error) {
    console.error(
      "webhook attempt failed",
      delivery.deliveryId,
      error instanceof Error ? error.name : "unknown",
    );
    result = failure("network");
  }
  const settle = settlement(delivery, result, runtime.now());
  try {
    const settled = await withTenant(app.db, scope.userId, (tx) =>
      settleWebhookDelivery(tx, settle),
    );
    return settled ? settle.outcome : null;
  } catch (error) {
    console.error(
      "webhook settle failed",
      delivery.deliveryId,
      error instanceof Error ? error.name : "unknown",
    );
    return null;
  }
}

export async function flushDueDeliveries(
  app: AppDatabase,
  scope: FlushScope,
  options: { deliveryId?: string } = {},
): Promise<FlushResult> {
  const runtime = webhookRuntime();
  const result: FlushResult = { claimed: 0, delivered: 0, retrying: 0, failed: 0 };
  let claimed: ClaimedWebhookDelivery[];
  try {
    claimed = await withTenant(app.db, scope.userId, (tx) =>
      claimWebhookDeliveries(tx, {
        workspaceId: scope.workspaceId,
        limit: WEBHOOK_BATCH_SIZE,
        leaseSeconds: WEBHOOK_LEASE_SECONDS,
        maxAttempts: WEBHOOK_MAX_ATTEMPTS,
        ...(options.deliveryId === undefined ? {} : { deliveryId: options.deliveryId }),
      }),
    );
  } catch (error) {
    console.error("webhook claim failed", error instanceof Error ? error.name : "unknown");
    return result;
  }
  result.claimed = claimed.length;
  const outcomes = await Promise.all(
    claimed.map((delivery) => deliver(app, scope, delivery, runtime)),
  );
  for (const outcome of outcomes) {
    if (outcome === "delivered") result.delivered += 1;
    else if (outcome === "retry") result.retrying += 1;
    else if (outcome === "failed") result.failed += 1;
  }
  return result;
}

export function kickWebhookDelivery(app: AppDatabase, scope: FlushScope): void {
  const target = { workspaceId: scope.workspaceId, userId: scope.userId };
  webhookRuntime().schedule(async () => {
    await flushDueDeliveries(app, target);
  });
}

const throttle = globalThis as typeof globalThis & {
  __delegateWebhookFlushes?: Map<string, number>;
};
const THROTTLE_ENTRIES_CEILING = 5_000;

export function flushSoon(app: AppDatabase, scope: FlushScope): boolean {
  const flushes = (throttle.__delegateWebhookFlushes ??= new Map<string, number>());
  const now = webhookRuntime().now().getTime();
  const last = flushes.get(scope.workspaceId);
  if (last !== undefined && now - last < WEBHOOK_FLUSH_THROTTLE_MS) return false;
  if (flushes.size >= THROTTLE_ENTRIES_CEILING) flushes.clear();
  flushes.set(scope.workspaceId, now);
  kickWebhookDelivery(app, scope);
  return true;
}

export function resetFlushThrottle(): void {
  throttle.__delegateWebhookFlushes?.clear();
}
