import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { type ApiDeps, handleCreateRun, handleGetRun, handleListRuns } from "./api";
import { createApiToken, revokeApiToken } from "./api-tokens";
import { type AppDatabase, createPgliteAppDatabase } from "./db";
import { createFakeRunner } from "./fake-runner";
import { handleMcp } from "./mcp-endpoint";
import { createRunRegistry } from "./run-registry";
import { createRateLimiter, resolveGuest } from "./session";

const ORIGIN = "https://delegate.example";
const secret = "s".repeat(32);

let app: AppDatabase;
const background: Promise<void>[] = [];

beforeAll(async () => {
  app = await createPgliteAppDatabase();
});

afterAll(async () => {
  await Promise.allSettled(background);
  await app.close();
});

function deps(): ApiDeps {
  return {
    app: () => Promise.resolve(app),
    secret: () => secret,
    guestLimiter: createRateLimiter({ limit: 50, windowMs: 3_600_000 }),
    ipLimiter: createRateLimiter({ limit: 50, windowMs: 3_600_000 }),
    registry: createRunRegistry(),
    runner: () => ({ execution: "simulated", run: createFakeRunner({ delayMs: 0 }) }),
    schedule: (task) => {
      background.push(task());
    },
    production: false,
  };
}

async function workspaceToken() {
  const { session } = await resolveGuest(app, undefined, secret);
  const { token, listing } = await createApiToken(app, session, "claude-code");
  return { session, token, tokenId: listing.id };
}

let rpcId = 0;

function rpc(method: string, params: unknown, token: string | null) {
  rpcId += 1;
  return new Request(`${ORIGIN}/api/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params }),
  });
}

const ToolResponse = z.object({
  result: z.object({
    content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
    isError: z.boolean().optional(),
  }),
});

async function callTool(token: string, name: string, args: Record<string, unknown>) {
  const response = await handleMcp(rpc("tools/call", { name, arguments: args }, token), deps());
  expect(response.status).toBe(200);
  const body = ToolResponse.parse(await response.json());
  return {
    isError: body.result.isError === true,
    text: body.result.content[0]?.text ?? "",
    json: () => JSON.parse(body.result.content[0]?.text ?? "null") as Record<string, unknown>,
  };
}

describe("/api/mcp auth", () => {
  it("rejects requests without a token", async () => {
    const response = await handleMcp(rpc("tools/list", {}, null), deps());
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/^Bearer/);
  });

  it("rejects malformed, unknown and revoked tokens", async () => {
    const { session, token, tokenId } = await workspaceToken();
    for (const bad of ["nope", `${token.slice(0, -2)}xx`]) {
      expect((await handleMcp(rpc("tools/list", {}, bad), deps())).status).toBe(401);
    }
    expect((await handleMcp(rpc("tools/list", {}, token), deps())).status).toBe(200);
    expect(await revokeApiToken(app, session, tokenId)).toBe(true);
    expect((await handleMcp(rpc("tools/list", {}, token), deps())).status).toBe(401);
  });

  it("refuses GET with 405", async () => {
    const { token } = await workspaceToken();
    const response = await handleMcp(
      new Request(`${ORIGIN}/api/mcp`, { headers: { authorization: `Bearer ${token}` } }),
      deps(),
    );
    expect(response.status).toBe(405);
  });

  it("rate limits per token", async () => {
    const { token } = await workspaceToken();
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    expect((await handleMcp(rpc("tools/list", {}, token), deps(), limiter)).status).toBe(200);
    expect((await handleMcp(rpc("tools/list", {}, token), deps(), limiter)).status).toBe(429);
  });
});

describe("/api/mcp tools", { timeout: 30_000 }, () => {
  it("starts a mission, approves its plan and returns the deliverable", async () => {
    const { token } = await workspaceToken();
    const started = await callTool(token, "start_mission", {
      missionId: "automation-audit",
      input: { url: "acme.example" },
    });
    expect(started.isError).toBe(false);
    const runId = z.uuid().parse(started.json().runId);
    expect(started.json().webUrl).toBe(`${ORIGIN}/runs/${runId}`);

    let waiting = await callTool(token, "wait_for_run", { runId, timeoutSeconds: 20 });
    expect(waiting.json()).toMatchObject({ status: "awaiting_plan_approval" });
    expect(waiting.json().pendingPlan).not.toBeNull();

    const approved = await callTool(token, "approve_plan", { runId });
    expect(approved.json()).toEqual({ decision: "approved" });

    waiting = await callTool(token, "wait_for_run", { runId, timeoutSeconds: 20 });
    expect(waiting.json()).toMatchObject({ status: "completed", terminal: true });
    expect(waiting.json().deliverable).toMatchObject({ kind: "automation-audit" });

    const listed = await callTool(token, "list_runs", {});
    expect(JSON.stringify(listed.json())).toContain(runId);
  });

  it("cannot see another workspace's runs", async () => {
    const owner = await workspaceToken();
    const stranger = await workspaceToken();
    const started = await callTool(owner.token, "start_mission", {
      missionId: "company-xray",
      input: { url: "acme.example" },
    });
    const runId = z.uuid().parse(started.json().runId);
    const seen = await callTool(stranger.token, "get_run", { runId });
    expect(seen.isError).toBe(true);
    const decided = await callTool(stranger.token, "approve_plan", { runId });
    expect(decided.isError).toBe(true);
  });

  it("returns validation problems as tool errors", async () => {
    const { token } = await workspaceToken();
    const result = await callTool(token, "start_mission", {
      missionId: "no-such-mission",
      input: { url: "acme.example" },
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/not valid/);
  });
});

describe("REST with a bearer token", () => {
  it("creates, reads and lists runs without a cookie or same-origin header", async () => {
    const { token } = await workspaceToken();
    const created = await handleCreateRun(
      new Request(`${ORIGIN}/api/runs`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          origin: "https://elsewhere.example",
        },
        body: JSON.stringify({ missionId: "company-xray", input: { url: "acme.example" } }),
      }),
      deps(),
    );
    expect(created.status).toBe(201);
    expect(created.headers.get("set-cookie")).toBeNull();
    const { runId } = z.object({ runId: z.uuid() }).parse(await created.json());
    const read = await handleGetRun(
      new Request(`${ORIGIN}/api/runs/${runId}?view=1`, {
        headers: { authorization: `Bearer ${token}` },
      }),
      runId,
      deps(),
    );
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ view: { id: runId, mission: "company-xray" } });
    const listed = await handleListRuns(
      new Request(`${ORIGIN}/api/runs`, { headers: { authorization: `Bearer ${token}` } }),
      deps(),
    );
    expect(JSON.stringify(await listed.json())).toContain(runId);
  });

  it("answers 401 for a bad bearer token instead of creating a guest", async () => {
    const response = await handleCreateRun(
      new Request(`${ORIGIN}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer dlg_nope" },
        body: JSON.stringify({ missionId: "company-xray", input: { url: "acme.example" } }),
      }),
      deps(),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
