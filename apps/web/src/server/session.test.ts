import { members, withTenant, workspaces } from "@delegate/db";
import { describe, expect, it, vi } from "vitest";

import { createPgliteAppDatabase } from "./db";
import {
  createGuest,
  createRateLimiter,
  resolveGuest,
  resolveSessionSecret,
  SESSION_COOKIE,
  sessionCookieOptions,
  signSession,
  verifySession,
} from "./session";

const secret = "a".repeat(32);
const session = {
  userId: "5d1f6a0e-8b8f-4f53-9a43-3f0f1d2b7c11",
  workspaceId: "0b6c9a55-2f0e-4f0d-8c1a-7e9d3b2a1f00",
};

describe("session cookie", () => {
  it("round-trips a signed session", () => {
    const value = signSession(session, secret, new Date("2026-11-24T10:00:00Z"));
    expect(verifySession(value, secret)).toEqual(session);
  });

  it("rejects a tampered payload", () => {
    const value = signSession(session, secret);
    const [payload, mac] = value.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        v: 1,
        u: session.userId,
        w: "11111111-1111-4111-8111-111111111111",
        iat: 1,
      }),
    ).toString("base64url");
    expect(payload).toBeDefined();
    expect(verifySession(`${forged}.${mac ?? ""}`, secret)).toBeNull();
  });

  it("rejects a tampered signature, a different secret and garbage", () => {
    const value = signSession(session, secret);
    const flipped = value.slice(0, -2) + (value.endsWith("AA") ? "BB" : "AA");
    expect(verifySession(flipped, secret)).toBeNull();
    expect(verifySession(value, "b".repeat(32))).toBeNull();
    expect(verifySession("not-a-cookie", secret)).toBeNull();
    expect(verifySession("", secret)).toBeNull();
    expect(verifySession(undefined, secret)).toBeNull();
  });

  it("rejects a correctly signed payload with the wrong shape", () => {
    const payload = Buffer.from(JSON.stringify({ v: 1, u: "not-a-uuid", w: "x", iat: 1 })).toString(
      "base64url",
    );
    const value = signSession(session, secret);
    expect(verifySession(`${payload}.${value.split(".")[1] ?? ""}`, secret)).toBeNull();
  });

  it("sets HTTP-only, SameSite=Lax and Secure only in production", () => {
    expect(SESSION_COOKIE).toBe("delegate_session");
    expect(sessionCookieOptions(true)).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/",
    });
    expect(sessionCookieOptions(false).secure).toBe(false);
  });
});

describe("resolveSessionSecret", () => {
  it("uses DELEGATE_SESSION_SECRET when it is long enough", () => {
    expect(resolveSessionSecret({ DELEGATE_SESSION_SECRET: secret, NODE_ENV: "production" })).toBe(
      secret,
    );
  });

  it("refuses to run in production without a strong secret", () => {
    expect(() => resolveSessionSecret({ NODE_ENV: "production" })).toThrow(
      /DELEGATE_SESSION_SECRET/,
    );
    expect(() =>
      resolveSessionSecret({ NODE_ENV: "production", DELEGATE_SESSION_SECRET: "short" }),
    ).toThrow(/32/);
  });

  it("generates a per-process secret in development and warns", () => {
    const warn = vi.fn();
    const first = resolveSessionSecret({ NODE_ENV: "development" }, warn);
    expect(first).toHaveLength(43);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("DELEGATE_SESSION_SECRET"));
  });
});

describe("createRateLimiter", () => {
  it("allows the limit within the window, then reports when to retry", () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000, now: () => now });
    expect(limiter.take("guest")).toEqual({ ok: true, remaining: 1 });
    now = 100;
    expect(limiter.take("guest")).toEqual({ ok: true, remaining: 0 });
    now = 400;
    expect(limiter.take("guest")).toEqual({ ok: false, retryAfterMs: 600 });
    expect(limiter.take("other")).toEqual({ ok: true, remaining: 1 });
    now = 1001;
    expect(limiter.take("guest")).toEqual({ ok: true, remaining: 0 });
  });
});

describe("guest provisioning", () => {
  it("creates a guest owner of a 7-day demo workspace and reuses a valid cookie", async () => {
    const app = await createPgliteAppDatabase();
    try {
      const guest = await createGuest(app);
      const rows = await withTenant(app.db, guest.userId, async (tx) => ({
        workspaces: await tx
          .select({ isDemo: workspaces.isDemo, retentionDays: workspaces.retentionDays })
          .from(workspaces),
        members: await tx.select({ role: members.role }).from(members),
      }));
      expect(rows).toEqual({
        workspaces: [{ isDemo: true, retentionDays: 7 }],
        members: [{ role: "owner" }],
      });

      const cookie = signSession(guest, secret);
      expect(await resolveGuest(app, cookie, secret)).toEqual({ session: guest, issued: false });
      const forged = signSession(guest, "c".repeat(32));
      const fresh = await resolveGuest(app, forged, secret);
      expect(fresh.issued).toBe(true);
      expect(fresh.session.userId).not.toBe(guest.userId);
    } finally {
      await app.close();
    }
  });
});
