import { createHash } from "node:crypto";

import {
  beginIdempotentRequest,
  completeIdempotentRequest,
  IDEMPOTENCY_RESPONSE_MAX_BYTES,
  releaseIdempotentRequest,
  withTenant,
} from "@delegate/db";
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_KEY_MAX_CHARS,
  IDEMPOTENCY_KEY_PATTERN,
  IDEMPOTENCY_TTL_SECONDS,
} from "@delegate/sdk/contract";

import type { AppDatabase } from "../db";
import type { GuestSession } from "../session";
import { V1Error } from "./errors";

export const IDEMPOTENCY_LOCK_SECONDS = 120;
export const IDEMPOTENCY_RETRY_AFTER_SECONDS = 2;

export interface JsonReply {
  status: number;
  body: string;
  headers: Record<string, string>;
}

export function idempotencyKeyOf(request: Request): string | null {
  const raw = request.headers.get(IDEMPOTENCY_KEY_HEADER);
  if (raw === null) return null;
  const key = raw.trim();
  if (!IDEMPOTENCY_KEY_PATTERN.test(key))
    throw new V1Error(
      "invalid_idempotency_key",
      `${IDEMPOTENCY_KEY_HEADER} must be 1 to ${IDEMPOTENCY_KEY_MAX_CHARS} printable ASCII characters without spaces.`,
    );
  return key;
}

export function requestFingerprint(method: string, path: string, body: string): string {
  return createHash("sha256")
    .update(`${method.toUpperCase()}\n${path}\n`, "utf8")
    .update(body, "utf8")
    .digest("hex");
}

function logFailure(what: string, error: unknown): void {
  console.error(what, error instanceof Error ? error.name : "unknown");
}

export async function runIdempotent(
  app: AppDatabase,
  session: GuestSession,
  scope: { key: string; requestHash: string },
  execute: () => Promise<JsonReply>,
): Promise<{ reply: JsonReply; replayed: boolean }> {
  const stored = { workspaceId: session.workspaceId, ...scope };
  const begun = await withTenant(app.db, session.userId, (tx) =>
    beginIdempotentRequest(tx, {
      ...stored,
      lockSeconds: IDEMPOTENCY_LOCK_SECONDS,
      ttlSeconds: IDEMPOTENCY_TTL_SECONDS,
    }),
  ).catch((error: unknown) => {
    logFailure("idempotency begin failed", error);
    throw new V1Error(
      "unavailable",
      `${IDEMPOTENCY_KEY_HEADER} cannot be honoured right now, so the request was not started. Try again shortly.`,
    );
  });
  if (begun.outcome === "replay")
    return { reply: { status: begun.status, body: begun.body, headers: {} }, replayed: true };
  if (begun.outcome === "mismatch")
    throw new V1Error(
      "idempotency_key_reused",
      `This ${IDEMPOTENCY_KEY_HEADER} was already used with a different request. Use a new key for a new request.`,
    );
  if (begun.outcome === "in_progress")
    throw new V1Error(
      "idempotency_in_progress",
      `A request with this ${IDEMPOTENCY_KEY_HEADER} is still being processed. Retry shortly to get its response.`,
      { headers: { "Retry-After": String(IDEMPOTENCY_RETRY_AFTER_SECONDS) } },
    );
  const release = () =>
    withTenant(app.db, session.userId, (tx) => releaseIdempotentRequest(tx, stored)).catch(
      (error: unknown) => {
        logFailure("idempotency release failed", error);
      },
    );
  let reply: JsonReply;
  try {
    reply = await execute();
  } catch (error) {
    await release();
    throw error;
  }
  const storable =
    reply.status >= 200 &&
    reply.status < 300 &&
    Buffer.byteLength(reply.body, "utf8") <= IDEMPOTENCY_RESPONSE_MAX_BYTES;
  if (!storable) {
    await release();
    return { reply, replayed: false };
  }
  await withTenant(app.db, session.userId, (tx) =>
    completeIdempotentRequest(tx, { ...stored, status: reply.status, body: reply.body }),
  ).catch((error: unknown) => {
    logFailure("idempotency complete failed", error);
  });
  return { reply, replayed: false };
}
