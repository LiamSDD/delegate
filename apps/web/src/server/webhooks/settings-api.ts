import {
  WEBHOOK_EVENT_MEANINGS,
  WEBHOOK_EVENT_TYPES,
  type WebhookEventType,
} from "@delegate/sdk/contract";
import type { z } from "zod";

import { type ApiDeps, apiError, retryAfterSeconds } from "../api";
import { hasBearer } from "../api-tokens";
import {
  bodyError,
  ensuredSession,
  existingSession,
  guardMutation,
  readBody,
} from "../connections-api";
import type { AppDatabase } from "../db";
import { siteOrigin } from "../mcp-endpoint";
import { createRateLimiter, type GuestSession, type RateLimiter } from "../session";
import { flushSoon } from "./dispatch";
import {
  AddWebhookEndpointSchema,
  addWebhookEndpoint,
  deleteWebhookEndpoint,
  listRecentDeliveries,
  listWebhookEndpoints,
  rotateWebhookSecret,
  sendTestDelivery,
  WEBHOOK_ENCRYPTION_KEY_MISSING_MESSAGE,
  type WebhookDeliveryListing,
  WebhookEndpointError,
  type WebhookEndpointListing,
} from "./endpoints";
import { MAX_WEBHOOK_ENDPOINTS, WEBHOOK_MAX_ATTEMPTS, WEBHOOK_TESTS_PER_MINUTE } from "./policy";
import { webhookRuntime } from "./runtime";

const NO_STORE = { "Cache-Control": "no-store" };

export interface WebhookSettingsDeps {
  api: ApiDeps;
  testLimiter: RateLimiter;
}

const limiterHolder = globalThis as typeof globalThis & {
  __delegateWebhookTestLimiter?: RateLimiter;
};

export function webhookTestLimiter(): RateLimiter {
  limiterHolder.__delegateWebhookTestLimiter ??= createRateLimiter({
    limit: WEBHOOK_TESTS_PER_MINUTE,
    windowMs: 60_000,
  });
  return limiterHolder.__delegateWebhookTestLimiter;
}

export interface WebhooksOverview {
  endpoints: WebhookEndpointListing[];
  deliveries: WebhookDeliveryListing[];
  encryptionConfigured: boolean;
  maxEndpoints: number;
  maxAttempts: number;
  eventTypes: { type: WebhookEventType; meaning: string }[];
}

export async function webhooksOverview(
  app: AppDatabase,
  session: GuestSession | null,
): Promise<WebhooksOverview> {
  return {
    endpoints: session === null ? [] : await listWebhookEndpoints(app, session),
    deliveries: session === null ? [] : await listRecentDeliveries(app, session),
    encryptionConfigured: webhookRuntime().box() !== null,
    maxEndpoints: MAX_WEBHOOK_ENDPOINTS,
    maxAttempts: WEBHOOK_MAX_ATTEMPTS,
    eventTypes: WEBHOOK_EVENT_TYPES.map((type) => ({
      type,
      meaning: WEBHOOK_EVENT_MEANINGS[type],
    })),
  };
}

function issues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
}

function endpointErrorResponse(error: WebhookEndpointError): Response {
  switch (error.code) {
    case "invalid_url":
      return apiError(400, "invalid_url", error.message);
    case "encryption_key_missing":
      return apiError(503, "unavailable", error.message);
    case "duplicate":
    case "limit":
      return apiError(409, "invalid_request", error.message);
    case "not_found":
      return apiError(404, "not_found", error.message);
  }
}

export async function handleWebhooksOverview(
  request: Request,
  deps: WebhookSettingsDeps,
): Promise<Response> {
  if (hasBearer(request))
    return apiError(403, "forbidden", "Settings are only available in the Delegate web app.");
  const { app, session } = await existingSession(request, deps);
  if (session !== null) flushSoon(app, session);
  return Response.json(await webhooksOverview(app, session), { headers: NO_STORE });
}

export async function handleAddWebhookEndpoint(
  request: Request,
  deps: WebhookSettingsDeps,
): Promise<Response> {
  const guard = guardMutation(request);
  if (guard !== null) return guard;
  const body = await readBody(request);
  const error = bodyError(body);
  if (error !== null) return error;
  const parsed = AddWebhookEndpointSchema.safeParse(body);
  if (!parsed.success)
    return apiError(400, "invalid_request", "The webhook endpoint is not valid.", {
      issues: issues(parsed.error),
    });
  const runtime = webhookRuntime();
  const box = runtime.box();
  if (box === null)
    return endpointErrorResponse(
      new WebhookEndpointError("encryption_key_missing", WEBHOOK_ENCRYPTION_KEY_MISSING_MESSAGE),
    );
  const { app, session, headers } = await ensuredSession(request, deps);
  try {
    const created = await addWebhookEndpoint(app, session, parsed.data, siteOrigin(request), {
      box,
      resolveDns: runtime.resolveDns,
    });
    return Response.json(created, { status: 201, headers: { ...NO_STORE, ...headers } });
  } catch (failure) {
    if (failure instanceof WebhookEndpointError) return endpointErrorResponse(failure);
    throw failure;
  }
}

export async function handleDeleteWebhookEndpoint(
  request: Request,
  endpointId: string,
  deps: WebhookSettingsDeps,
): Promise<Response> {
  const guard = guardMutation(request);
  if (guard !== null) return guard;
  const { app, session } = await existingSession(request, deps);
  if (session === null || !(await deleteWebhookEndpoint(app, session, endpointId)))
    return apiError(404, "not_found", "No webhook endpoint with that id.");
  return Response.json({ deleted: true }, { headers: NO_STORE });
}

export async function handleRotateWebhookSecret(
  request: Request,
  endpointId: string,
  deps: WebhookSettingsDeps,
): Promise<Response> {
  const guard = guardMutation(request);
  if (guard !== null) return guard;
  const { app, session } = await existingSession(request, deps);
  if (session === null) return apiError(404, "not_found", "No webhook endpoint with that id.");
  try {
    const rotated = await rotateWebhookSecret(app, session, endpointId, {
      box: webhookRuntime().box(),
    });
    return Response.json(rotated, { headers: NO_STORE });
  } catch (failure) {
    if (failure instanceof WebhookEndpointError) return endpointErrorResponse(failure);
    throw failure;
  }
}

export async function handleTestWebhookEndpoint(
  request: Request,
  endpointId: string,
  deps: WebhookSettingsDeps,
): Promise<Response> {
  const guard = guardMutation(request);
  if (guard !== null) return guard;
  const { app, session } = await existingSession(request, deps);
  if (session === null) return apiError(404, "not_found", "No webhook endpoint with that id.");
  const quota = deps.testLimiter.take(session.workspaceId);
  if (!quota.ok)
    return apiError(429, "rate_limited", "Too many test deliveries. Try again in a minute.", {
      headers: { "Retry-After": retryAfterSeconds(quota.retryAfterMs) },
    });
  try {
    const delivery = await sendTestDelivery(app, session, endpointId);
    return Response.json({ delivery }, { headers: NO_STORE });
  } catch (failure) {
    if (failure instanceof WebhookEndpointError) return endpointErrorResponse(failure);
    throw failure;
  }
}
