import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ApiDeps } from "./api";
import {
  type ConnectionsDeps,
  handleGithubCallback,
  handleGithubConnect,
  handleGithubSetup,
} from "./connections-api";
import { type AppDatabase, createPgliteAppDatabase } from "./db";
import {
  findInstallationForRepo,
  GITHUB_STATE_COOKIE,
  issueGithubState,
  listInstallations,
  verifyGithubState,
} from "./github-connect";
import { createRunRegistry } from "./run-registry";
import { createRateLimiter, type GuestSession, resolveGuest, signSession } from "./session";

const ORIGIN = "https://delegate.example";
const secret = "s".repeat(32);
const config = { clientId: "Iv1.client", clientSecret: "shh", slug: "delegate-dev" };
let app: AppDatabase;

beforeAll(async () => {
  app = await createPgliteAppDatabase();
});

afterAll(async () => {
  await app.close();
});

const guest = async () => (await resolveGuest(app, undefined, secret)).session;

interface FakeGithub {
  fetch: typeof fetch;
  calls: string[];
}

function fakeGithub(installations: unknown[], repositories: string[] = []): FakeGithub {
  const calls: string[] = [];
  const impl: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url === "https://github.com/login/oauth/access_token") {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        code: string;
        client_secret: string;
      };
      return Promise.resolve(
        body.code === "good" && body.client_secret === "shh"
          ? Response.json({ access_token: "ghu_user", token_type: "bearer" })
          : Response.json({ error: "bad_verification_code" }),
      );
    }
    if (url.startsWith("https://api.github.com/user/installations?"))
      return Promise.resolve(Response.json({ total_count: installations.length, installations }));
    if (/\/user\/installations\/\d+\/repositories/.test(url))
      return Promise.resolve(
        Response.json({
          total_count: repositories.length,
          repositories: repositories.map((full_name) => ({ full_name })),
        }),
      );
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
  return { fetch: impl, calls };
}

function deps(github: FakeGithub): ConnectionsDeps {
  const api: ApiDeps = {
    app: () => Promise.resolve(app),
    secret: () => secret,
    guestLimiter: createRateLimiter({ limit: 50, windowMs: 3_600_000 }),
    ipLimiter: createRateLimiter({ limit: 50, windowMs: 3_600_000 }),
    registry: createRunRegistry(),
    runner: () => {
      throw new Error("not used");
    },
    schedule: () => undefined,
    production: true,
  };
  return {
    api,
    connectors: () => ({ production: true, box: null, open: () => Promise.reject(new Error()) }),
    github: () => config,
    fetch: github.fetch,
  };
}

function cookieHeader(session: GuestSession, nonce: string) {
  return `delegate_session=${signSession(session, secret)}; ${GITHUB_STATE_COOKIE}=${nonce}`;
}

function callback(query: Record<string, string>, cookie: string) {
  const url = new URL(`${ORIGIN}/api/github/callback`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return new Request(url, { headers: { cookie } });
}

const mine = {
  id: 101,
  app_slug: "delegate-dev",
  account: { login: "Octo-Org", type: "Organization" },
  repository_selection: "selected",
};

describe("GitHub state", () => {
  it("verifies a fresh state bound to the session and the cookie nonce", async () => {
    const session = await guest();
    const { state, nonce } = issueGithubState(session, secret, { installationId: 7 });
    expect(verifyGithubState(state, { secret, cookieNonce: nonce, session })).toMatchObject({
      ok: true,
      state: { i: 7, w: session.workspaceId },
    });
  });

  it("rejects tampered, expired, cross-session and cookie-less states", async () => {
    const session = await guest();
    const other = await guest();
    const { state, nonce } = issueGithubState(session, secret);
    const [payload, signature] = state.split(".");
    const forged = `${Buffer.from(
      Buffer.from(payload ?? "", "base64url")
        .toString("utf8")
        .replace(session.workspaceId, other.workspaceId),
    ).toString("base64url")}.${signature ?? ""}`;
    expect(verifyGithubState(forged, { secret, cookieNonce: nonce, session })).toEqual({
      ok: false,
      reason: "signature",
    });
    expect(
      verifyGithubState(state, {
        secret,
        cookieNonce: nonce,
        session,
        now: new Date(Date.now() + 11 * 60_000),
      }),
    ).toEqual({ ok: false, reason: "expired" });
    expect(verifyGithubState(state, { secret, cookieNonce: nonce, session: other })).toEqual({
      ok: false,
      reason: "session",
    });
    expect(verifyGithubState(state, { secret, cookieNonce: undefined, session })).toEqual({
      ok: false,
      reason: "nonce",
    });
    expect(verifyGithubState(null, { secret, cookieNonce: nonce, session }).ok).toBe(false);
  });
});

describe("GitHub connect flow", () => {
  it("redirects to GitHub's authorize page with a state cookie", async () => {
    const response = await handleGithubConnect(
      new Request(`${ORIGIN}/api/github/connect`),
      deps(fakeGithub([])),
    );
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("Iv1.client");
    expect(location.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/github/callback`);
    expect(location.searchParams.get("state")).not.toBeNull();
    const cookies = response.headers.getSetCookie().join("\n");
    expect(cookies).toMatch(new RegExp(`${GITHUB_STATE_COOKIE}=[^;]+; Path=/api/github`));
    expect(cookies).toContain("HttpOnly");
  });

  it("sends the setup redirect back through authorization with the installation in state", async () => {
    const response = await handleGithubSetup(
      new Request(`${ORIGIN}/api/github/setup?installation_id=101&setup_action=install`),
      deps(fakeGithub([])),
    );
    const location = new URL(response.headers.get("location") ?? "");
    const state = location.searchParams.get("state") ?? "";
    const payload = JSON.parse(
      Buffer.from(state.split(".")[0] ?? "", "base64url").toString("utf8"),
    ) as { i?: number };
    expect(payload.i).toBe(101);
  });

  it("stores an installation the authorizing user can access, without keeping the user token", async () => {
    const session = await guest();
    const github = fakeGithub([mine], ["Octo-Org/api", "Octo-Org/web"]);
    const { state, nonce } = issueGithubState(session, secret, { installationId: 101 });
    const response = await handleGithubCallback(
      callback({ code: "good", state }, cookieHeader(session, nonce)),
      deps(github),
    );
    expect(response.headers.get("location")).toBe(
      `${ORIGIN}/settings/connections?github=installed`,
    );
    expect(github.calls).toContain("GET https://api.github.com/user/installations?per_page=100");
    const [stored] = await listInstallations(app, session);
    expect(stored).toMatchObject({
      installationId: 101,
      accountLogin: "Octo-Org",
      repositorySelection: "selected",
      repositories: ["Octo-Org/api", "Octo-Org/web"],
    });
    expect(JSON.stringify(stored)).not.toContain("ghu_user");

    const scope = { app, userId: session.userId };
    expect(await findInstallationForRepo(session.workspaceId, "octo-org", "API", scope)).toEqual({
      installationId: 101,
      accountLogin: "Octo-Org",
      repositorySelection: "selected",
    });
    expect(await findInstallationForRepo(session.workspaceId, "Octo-Org", "secret", scope)).toBe(
      null,
    );
    expect(await findInstallationForRepo(session.workspaceId, "someone", "api", scope)).toBeNull();
    const stranger = await guest();
    expect(
      await findInstallationForRepo(session.workspaceId, "Octo-Org", "api", {
        app,
        userId: stranger.userId,
      }),
    ).toBeNull();
  });

  it("refuses an installation id the user cannot access", async () => {
    const session = await guest();
    const { state, nonce } = issueGithubState(session, secret, { installationId: 999 });
    const response = await handleGithubCallback(
      callback({ code: "good", state }, cookieHeader(session, nonce)),
      deps(fakeGithub([mine])),
    );
    expect(response.headers.get("location")).toContain("github=not_your_installation");
    expect(await listInstallations(app, session)).toEqual([]);
  });

  it("refuses a callback whose state does not match the session cookie", async () => {
    const victim = await guest();
    const attacker = await guest();
    const { state, nonce } = issueGithubState(attacker, secret, { installationId: 101 });
    const github = fakeGithub([mine]);
    const response = await handleGithubCallback(
      callback({ code: "good", state }, cookieHeader(victim, nonce)),
      deps(github),
    );
    expect(response.headers.get("location")).toContain("github=state_rejected");
    expect(github.calls).toEqual([]);
    expect(await listInstallations(app, victim)).toEqual([]);
  });

  it("reports a code GitHub does not accept", async () => {
    const session = await guest();
    const { state, nonce } = issueGithubState(session, secret, { installationId: 101 });
    const response = await handleGithubCallback(
      callback({ code: "bad", state }, cookieHeader(session, nonce)),
      deps(fakeGithub([mine])),
    );
    expect(response.headers.get("location")).toContain("github=exchange_failed");
  });
});
