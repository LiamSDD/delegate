import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { createGuestWorkspace, withTenant, workspaces } from "@delegate/db";
import { eq } from "drizzle-orm";
import { z } from "zod";

import type { AppDatabase } from "./db";

export const SESSION_COOKIE = "delegate_session";
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const MIN_SECRET_LENGTH = 32;

export interface GuestSession {
  userId: string;
  workspaceId: string;
}

const cookiePayloadSchema = z.strictObject({
  v: z.literal(1),
  u: z.uuid(),
  w: z.uuid(),
  iat: z.int().nonnegative(),
});

function mac(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(payload, "utf8").digest();
}

export function signSession(session: GuestSession, secret: string, now = new Date()): string {
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      u: session.userId,
      w: session.workspaceId,
      iat: Math.floor(now.getTime() / 1000),
    }),
    "utf8",
  ).toString("base64url");
  return `${payload}.${mac(payload, secret).toString("base64url")}`;
}

export function verifySession(value: string | undefined, secret: string): GuestSession | null {
  if (value === undefined) return null;
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  if (payload === undefined || signature === undefined || payload === "") return null;
  const expected = mac(payload, secret);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const parsed = cookiePayloadSchema.safeParse(decoded);
  if (!parsed.success) return null;
  return { userId: parsed.data.u, workspaceId: parsed.data.w };
}

export interface SessionCookieOptions {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: "/";
  maxAge: number;
}

export function sessionCookieOptions(production: boolean): SessionCookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: production,
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}

const sessionEnvSchema = z.object({
  NODE_ENV: z.string().optional(),
  DELEGATE_SESSION_SECRET: z.string().optional(),
});

export function resolveSessionSecret(
  env: Record<string, string | undefined>,
  warn: (message: string) => void = console.warn,
): string {
  const parsed = sessionEnvSchema.parse(env);
  const secret = parsed.DELEGATE_SESSION_SECRET ?? "";
  if (secret !== "") {
    if (secret.length < MIN_SECRET_LENGTH) {
      throw new Error(`DELEGATE_SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
    }
    return secret;
  }
  if (parsed.NODE_ENV === "production") {
    throw new Error("DELEGATE_SESSION_SECRET is required in production");
  }
  warn(
    "DELEGATE_SESSION_SECRET is not set: using a random per-process secret, so guest sessions reset when the server restarts.",
  );
  return randomBytes(32).toString("base64url");
}

const secretHolder = globalThis as typeof globalThis & { __delegateSessionSecret?: string };

export function sessionSecret(): string {
  secretHolder.__delegateSessionSecret ??= resolveSessionSecret(process.env);
  return secretHolder.__delegateSessionSecret;
}

export interface RateLimiter {
  take(key: string): { ok: true; remaining: number } | { ok: false; retryAfterMs: number };
}

export function createRateLimiter(options: {
  limit: number;
  windowMs: number;
  now?: () => number;
}): RateLimiter {
  const now = options.now ?? Date.now;
  const hits = new Map<string, number[]>();
  return {
    take(key) {
      const at = now();
      const recent = (hits.get(key) ?? []).filter((time) => at - time < options.windowMs);
      if (recent.length >= options.limit) {
        hits.set(key, recent);
        const oldest = recent[0] ?? at;
        return { ok: false, retryAfterMs: oldest + options.windowMs - at };
      }
      recent.push(at);
      hits.set(key, recent);
      return { ok: true, remaining: options.limit - recent.length };
    },
  };
}

export const GUEST_RUNS_PER_HOUR = 5;
export const NETWORK_RUNS_PER_HOUR = 20;

const limiterHolder = globalThis as typeof globalThis & {
  __delegateRunLimiter?: RateLimiter;
  __delegateNetworkLimiter?: RateLimiter;
};

export function networkRunLimiter(): RateLimiter {
  limiterHolder.__delegateNetworkLimiter ??= createRateLimiter({
    limit: NETWORK_RUNS_PER_HOUR,
    windowMs: 60 * 60 * 1000,
  });
  return limiterHolder.__delegateNetworkLimiter;
}

export function guestRunLimiter(): RateLimiter {
  limiterHolder.__delegateRunLimiter ??= createRateLimiter({
    limit: GUEST_RUNS_PER_HOUR,
    windowMs: 60 * 60 * 1000,
  });
  return limiterHolder.__delegateRunLimiter;
}

export function createGuest(app: AppDatabase): Promise<GuestSession> {
  return createGuestWorkspace(app.db);
}

export async function isLiveSession(app: AppDatabase, session: GuestSession): Promise<boolean> {
  const rows = await withTenant(app.db, session.userId, (tx) =>
    tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, session.workspaceId)),
  );
  return rows.length === 1;
}

export async function resolveGuest(
  app: AppDatabase,
  cookieValue: string | undefined,
  secret: string,
): Promise<{ session: GuestSession; issued: boolean }> {
  const existing = verifySession(cookieValue, secret);
  if (existing !== null && (await isLiveSession(app, existing))) {
    return { session: existing, issued: false };
  }
  return { session: await createGuest(app), issued: true };
}

export async function readGuest(
  app: AppDatabase,
  cookieValue: string | undefined,
  secret: string,
): Promise<GuestSession | null> {
  const existing = verifySession(cookieValue, secret);
  if (existing === null) return null;
  return (await isLiveSession(app, existing)) ? existing : null;
}
