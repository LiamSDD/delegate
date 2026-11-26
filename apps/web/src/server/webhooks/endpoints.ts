import { randomBytes } from "node:crypto";

import {
  enqueueWebhookTest,
  type WebhookDeliveryStatus,
  webhookDeliveries,
  webhookEndpoints,
  withTenant,
} from "@delegate/db";
import type { ResolveDns } from "@delegate/runtime/security";
import {
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_SECRET_PREFIX,
  type WebhookEventType,
  WebhookEventTypeSchema,
} from "@delegate/sdk/contract";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { AppDatabase } from "../db";
import type { SecretBox } from "../secrets";
import type { GuestSession } from "../session";
import { flushDueDeliveries } from "./dispatch";
import { MAX_WEBHOOK_ENDPOINTS } from "./policy";
import { assertPublicHost, validateWebhookUrl, WebhookUrlError } from "./url";

export const WEBHOOK_ENCRYPTION_KEY_MISSING_MESSAGE =
  "Webhook endpoints cannot be added because DELEGATE_ENCRYPTION_KEY is not set on this deployment: the signing secret has to be stored encrypted (generate a key with `openssl rand -hex 32`).";
export const RECENT_DELIVERIES_LIMIT = 50;
export const TEST_DELIVERY_MESSAGE =
  "This is a test delivery from Delegate. Verify its signature like any other.";

export const AddWebhookEndpointSchema = z.strictObject({
  url: z.string().trim().min(1).max(2048),
  events: z
    .array(WebhookEventTypeSchema)
    .min(1)
    .max(WEBHOOK_EVENT_TYPES.length)
    .transform((events) => WEBHOOK_EVENT_TYPES.filter((type) => events.includes(type))),
  description: z.string().trim().max(120).default(""),
});
export type AddWebhookEndpoint = z.infer<typeof AddWebhookEndpointSchema>;

export type WebhookEndpointErrorCode =
  "invalid_url" | "encryption_key_missing" | "duplicate" | "limit" | "not_found";

export class WebhookEndpointError extends Error {
  override readonly name = "WebhookEndpointError";
  constructor(
    readonly code: WebhookEndpointErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface WebhookEndpointListing {
  id: string;
  url: string;
  host: string;
  description: string;
  events: WebhookEventType[];
  createdAt: string;
  secretRotatedAt: string | null;
}

export interface WebhookDeliveryListing {
  id: string;
  endpointId: string;
  runId: string | null;
  eventType: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  lastStatusCode: number | null;
  lastError: string | null;
  lastResponseExcerpt: string | null;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

export interface EndpointDeps {
  box: SecretBox | null;
  resolveDns: ResolveDns;
  random?: (size: number) => Buffer;
}

export function mintWebhookSecret(random: (size: number) => Buffer = randomBytes): string {
  return `${WEBHOOK_SECRET_PREFIX}${random(32).toString("base64url")}`;
}

const endpointColumns = {
  id: webhookEndpoints.id,
  url: webhookEndpoints.url,
  description: webhookEndpoints.description,
  events: webhookEndpoints.events,
  createdAt: webhookEndpoints.createdAt,
  secretRotatedAt: webhookEndpoints.secretRotatedAt,
};

interface EndpointRow {
  id: string;
  url: string;
  description: string;
  events: string[];
  createdAt: Date;
  secretRotatedAt: Date | null;
}

function endpointListing(row: EndpointRow): WebhookEndpointListing {
  return {
    id: row.id,
    url: row.url,
    host: new URL(row.url).hostname,
    description: row.description,
    events: WEBHOOK_EVENT_TYPES.filter((type) => row.events.includes(type)),
    createdAt: row.createdAt.toISOString(),
    secretRotatedAt: row.secretRotatedAt?.toISOString() ?? null,
  };
}

export async function listWebhookEndpoints(
  app: AppDatabase,
  session: GuestSession,
): Promise<WebhookEndpointListing[]> {
  const rows = await withTenant(app.db, session.userId, (tx) =>
    tx
      .select(endpointColumns)
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.workspaceId, session.workspaceId))
      .orderBy(asc(webhookEndpoints.createdAt)),
  );
  return rows.map(endpointListing);
}

function postgresCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const code = (current as Error & { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = current.cause;
  }
  return null;
}

export async function addWebhookEndpoint(
  app: AppDatabase,
  session: GuestSession,
  request: AddWebhookEndpoint,
  origin: string,
  deps: EndpointDeps,
): Promise<{ endpoint: WebhookEndpointListing; secret: string }> {
  if (deps.box === null)
    throw new WebhookEndpointError(
      "encryption_key_missing",
      WEBHOOK_ENCRYPTION_KEY_MISSING_MESSAGE,
    );
  let url: URL;
  try {
    url = validateWebhookUrl(request.url);
    await assertPublicHost(url, deps.resolveDns);
  } catch (error) {
    if (error instanceof WebhookUrlError)
      throw new WebhookEndpointError("invalid_url", error.message);
    throw error;
  }
  const existing = await listWebhookEndpoints(app, session);
  if (existing.length >= MAX_WEBHOOK_ENDPOINTS)
    throw new WebhookEndpointError(
      "limit",
      `A workspace can have at most ${MAX_WEBHOOK_ENDPOINTS} webhook endpoints.`,
    );
  if (existing.some((endpoint) => endpoint.url === url.href))
    throw new WebhookEndpointError("duplicate", "This URL is already a webhook endpoint.");
  const id = crypto.randomUUID();
  const secret = mintWebhookSecret(deps.random);
  const sealed = deps.box.seal(secret, id);
  try {
    const [row] = await withTenant(app.db, session.userId, (tx) =>
      tx
        .insert(webhookEndpoints)
        .values({
          id,
          workspaceId: session.workspaceId,
          url: url.href,
          origin,
          description: request.description,
          events: request.events,
          secretCiphertext: sealed,
        })
        .returning(endpointColumns),
    );
    if (row === undefined) throw new Error("webhook endpoint insert returned no row");
    return { endpoint: endpointListing(row), secret };
  } catch (error) {
    if (postgresCode(error) === "23505")
      throw new WebhookEndpointError("duplicate", "This URL is already a webhook endpoint.");
    throw error;
  }
}

export async function rotateWebhookSecret(
  app: AppDatabase,
  session: GuestSession,
  endpointId: string,
  deps: Pick<EndpointDeps, "box" | "random">,
): Promise<{ endpoint: WebhookEndpointListing; secret: string }> {
  if (!z.uuid().safeParse(endpointId).success)
    throw new WebhookEndpointError("not_found", "No webhook endpoint with that id.");
  if (deps.box === null)
    throw new WebhookEndpointError(
      "encryption_key_missing",
      WEBHOOK_ENCRYPTION_KEY_MISSING_MESSAGE,
    );
  const secret = mintWebhookSecret(deps.random);
  const sealed = deps.box.seal(secret, endpointId);
  const [row] = await withTenant(app.db, session.userId, (tx) =>
    tx
      .update(webhookEndpoints)
      .set({ secretCiphertext: sealed, secretRotatedAt: sql`now()` })
      .where(
        and(
          eq(webhookEndpoints.id, endpointId),
          eq(webhookEndpoints.workspaceId, session.workspaceId),
        ),
      )
      .returning(endpointColumns),
  );
  if (row === undefined)
    throw new WebhookEndpointError("not_found", "No webhook endpoint with that id.");
  return { endpoint: endpointListing(row), secret };
}

export async function deleteWebhookEndpoint(
  app: AppDatabase,
  session: GuestSession,
  endpointId: string,
): Promise<boolean> {
  if (!z.uuid().safeParse(endpointId).success) return false;
  const rows = await withTenant(app.db, session.userId, (tx) =>
    tx
      .delete(webhookEndpoints)
      .where(
        and(
          eq(webhookEndpoints.id, endpointId),
          eq(webhookEndpoints.workspaceId, session.workspaceId),
        ),
      )
      .returning({ id: webhookEndpoints.id }),
  );
  return rows.length === 1;
}

type DeliveryRow = typeof webhookDeliveries.$inferSelect;

function deliveryListing(row: DeliveryRow): WebhookDeliveryListing {
  return {
    id: row.id,
    endpointId: row.endpointId,
    runId: row.runId,
    eventType: row.eventType,
    status: row.status,
    attempts: row.attempts,
    lastStatusCode: row.lastStatusCode,
    lastError: row.lastError,
    lastResponseExcerpt: row.lastResponseExcerpt,
    lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listRecentDeliveries(
  app: AppDatabase,
  session: GuestSession,
  limit = RECENT_DELIVERIES_LIMIT,
): Promise<WebhookDeliveryListing[]> {
  const rows = await withTenant(app.db, session.userId, (tx) =>
    tx
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.workspaceId, session.workspaceId))
      .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
      .limit(limit),
  );
  return rows.map(deliveryListing);
}

export async function sendTestDelivery(
  app: AppDatabase,
  session: GuestSession,
  endpointId: string,
): Promise<WebhookDeliveryListing> {
  const notFound = new WebhookEndpointError("not_found", "No webhook endpoint with that id.");
  if (!z.uuid().safeParse(endpointId).success) throw notFound;
  const owned = (await listWebhookEndpoints(app, session)).some(
    (endpoint) => endpoint.id === endpointId,
  );
  if (!owned) throw notFound;
  const deliveryId = await withTenant(app.db, session.userId, (tx) =>
    enqueueWebhookTest(tx, { endpointId, data: { message: TEST_DELIVERY_MESSAGE } }),
  );
  await flushDueDeliveries(app, session, { deliveryId });
  const [row] = await withTenant(app.db, session.userId, (tx) =>
    tx.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId)),
  );
  if (row === undefined) throw notFound;
  return deliveryListing(row);
}
