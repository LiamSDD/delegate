import {
  ArtifactListSchema,
  ArtifactSchema,
  AssistantListSchema,
  ChatAnswerSchema,
  ErrorEnvelopeSchema,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_REPLAYED_HEADER,
  MISSION_IDS,
  OPERATIONS,
  PlanDecisionResultSchema,
  RATE_LIMIT_HEADERS,
  REQUEST_ID_HEADER,
  type Run,
  RunEventPageSchema,
  RunListSchema,
  RunSchema,
} from "@delegate/sdk/contract";
import { parseSse } from "@delegate/sdk";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { handleCreateRun } from "../api";
import { revokeApiToken } from "../api-tokens";
import { type AppDatabase, createPgliteAppDatabase } from "../db";
import { appendEvent, createRunRecord } from "../runs";
import { createRateLimiter, SESSION_COOKIE, signSession } from "../session";
import { configureWebhooks } from "../webhooks/runtime";
import { resetFlushThrottle } from "../webhooks/dispatch";
import type { V1Deps } from "./handlers";
import { createRequestLimiter } from "./rate-limit";
import {
  createBackground,
  createTestWebhooks,
  dispatchV1,
  type SendOptions,
  TEST_ORIGIN,
  TEST_SESSION_SECRET,
  testApiDeps,
  testV1Deps,
  v1Request,
  workspaceWithToken,
} from "./testing";

let app: AppDatabase;
const background = createBackground();

beforeAll(async () => {
  app = await createPgliteAppDatabase();
  configureWebhooks(createTestWebhooks(background).runtime);
});

afterEach(() => {
  resetFlushThrottle();
});

afterAll(async () => {
  await background.stop();
  configureWebhooks(null);
  await app.close();
});

function deps(overrides: Parameters<typeof testV1Deps>[2] = {}): V1Deps {
  return testV1Deps(app, background, overrides);
}

function send(
  method: "GET" | "POST",
  path: string,
  options: SendOptions = {},
  using: V1Deps = deps(),
): Promise<Response> {
  return dispatchV1(v1Request(method, path, options), using);
}

async function errorOf(response: Response) {
  const envelope = ErrorEnvelopeSchema.parse(await response.json());
  expect(envelope.error.requestId).toBe(response.headers.get(REQUEST_ID_HEADER));
  return envelope.error;
}

async function createRun(token: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await send("POST", "/runs", { token, body, headers });
  expect(response.status).toBe(201);
  return RunSchema.parse(await response.json());
}

async function getRun(token: string, runId: string): Promise<Run> {
  const response = await send("GET", `/runs/${runId}`, { token });
  expect(response.status).toBe(200);
  return RunSchema.parse(await response.json());
}

async function waitFor(token: string, runId: string, done: (run: Run) => boolean): Promise<Run> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const run = await getRun(token, runId);
    if (done(run)) return run;
    if (Date.now() > deadline) throw new Error(`run ${runId} stayed ${run.status}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

const XRAY = { missionId: "company-xray", input: { url: "acme.example" } };
const AUDIT = { missionId: "automation-audit", input: { url: "acme.example" } };

describe("v1 authentication", () => {
  it("answers 401 in the error envelope without a token", async () => {
    const response = await send("GET", "/runs");
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/^Bearer/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const error = await errorOf(response);
    expect(error.code).toBe("unauthorized");
    expect(error.requestId).toMatch(/^req_[0-9a-f]{32}$/);
  });

  it("rejects malformed, unknown and revoked tokens on every operation", async () => {
    const { session, token, tokenId } = await workspaceWithToken(app);
    const run = await createRun(token, XRAY);
    const calls: ["GET" | "POST", string, unknown?][] = [
      ["POST", "/runs", XRAY],
      ["GET", "/runs"],
      ["GET", `/runs/${run.id}`],
      ["POST", `/runs/${run.id}/cancel`],
      ["GET", `/runs/${run.id}/events`],
      ["POST", `/runs/${run.id}/plan/approve`],
      ["POST", `/runs/${run.id}/plan/reject`],
      ["GET", `/runs/${run.id}/artifacts`],
      ["GET", `/runs/${run.id}/artifacts/brief`],
      ["GET", "/assistants"],
      ["POST", `/assistants/${run.id}/chat`, { question: "hi" }],
    ];
    expect(calls).toHaveLength(Object.keys(OPERATIONS).length - 1);
    for (const bad of ["nope", `${token.slice(0, -2)}xx`, ""]) {
      for (const [method, path, body] of calls) {
        const response = await send(method, path, { token: bad, body });
        expect(response.status, `${method} ${path}`).toBe(401);
      }
    }
    expect(await revokeApiToken(app, session, tokenId)).toBe(true);
    for (const [method, path, body] of calls) {
      const response = await send(method, path, { token, body });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });

  it("ignores a valid session cookie: v1 is bearer only", async () => {
    const { session, token } = await workspaceWithToken(app);
    const run = await createRun(token, XRAY);
    const cookie = `${SESSION_COOKIE}=${signSession(session, TEST_SESSION_SECRET)}`;
    const response = await send("GET", `/runs/${run.id}`, { headers: { cookie } });
    expect(response.status).toBe(401);
  });

  it("does not expose side-effect approvals", async () => {
    const paths = Object.values(OPERATIONS).map((spec) => spec.path);
    expect(paths.filter((path) => /ship|approval|tool/.test(path))).toEqual([]);
    const { token } = await workspaceWithToken(app);
    const run = await createRun(token, XRAY);
    for (const path of [`/runs/${run.id}/ship/approve`, `/runs/${run.id}/approvals/abc`]) {
      const response = await send("POST", path, { token, body: { decision: "approved" } });
      expect(response.status).toBe(404);
      expect((await errorOf(response)).code).toBe("not_found");
    }
  });

  it("serves the OpenAPI document without a token", async () => {
    const response = await send("GET", "/openapi.json");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toContain("public");
    const document = (await response.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(document.openapi).toMatch(/^3\.1\./);
    expect(Object.keys(document.paths)).toContain("/runs/{runId}/events");
  });
});

describe("v1 rate limiting", () => {
  it("reports the request budget on every response and answers 429 with Retry-After", async () => {
    const { token } = await workspaceWithToken(app);
    const limited = deps({ limiter: createRequestLimiter({ limit: 2, windowMs: 60_000 }) });
    const first = await send("GET", "/runs", { token }, limited);
    expect(first.status).toBe(200);
    expect(first.headers.get(RATE_LIMIT_HEADERS.limit)).toBe("2");
    expect(first.headers.get(RATE_LIMIT_HEADERS.remaining)).toBe("1");
    expect(Number(first.headers.get(RATE_LIMIT_HEADERS.reset))).toBeGreaterThan(0);
    const invalid = await send("GET", "/runs?limit=0", { token }, limited);
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get(RATE_LIMIT_HEADERS.remaining)).toBe("0");
    const third = await send("GET", "/runs", { token }, limited);
    expect(third.status).toBe(429);
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(third.headers.get(RATE_LIMIT_HEADERS.remaining)).toBe("0");
    expect((await errorOf(third)).code).toBe("rate_limited");
  });

  it("keeps separate budgets per token", async () => {
    const one = await workspaceWithToken(app);
    const two = await workspaceWithToken(app);
    const limited = deps({ limiter: createRequestLimiter({ limit: 1, windowMs: 60_000 }) });
    expect((await send("GET", "/runs", { token: one.token }, limited)).status).toBe(200);
    expect((await send("GET", "/runs", { token: one.token }, limited)).status).toBe(429);
    expect((await send("GET", "/runs", { token: two.token }, limited)).status).toBe(200);
  });

  it("applies the existing per-user run quota with Retry-After", async () => {
    const { token } = await workspaceWithToken(app);
    const tight = deps({
      api: { guestLimiter: createRateLimiter({ limit: 1, windowMs: 3_600_000 }) },
    });
    expect((await send("POST", "/runs", { token, body: XRAY }, tight)).status).toBe(201);
    const refused = await send("POST", "/runs", { token, body: XRAY }, tight);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await errorOf(refused)).code).toBe("rate_limited");
  });
});

describe("POST /api/v1/runs", () => {
  it("creates a run and answers 201 with its resource and Location", async () => {
    const { token } = await workspaceWithToken(app);
    const response = await send("POST", "/runs", { token, body: XRAY });
    expect(response.status).toBe(201);
    const run = RunSchema.parse(await response.json());
    expect(response.headers.get("location")).toBe(`/api/v1/runs/${run.id}`);
    expect(run).toMatchObject({
      mission: "company-xray",
      target: "acme.example",
      execution: "simulated",
      terminal: false,
      webUrl: `${TEST_ORIGIN}/runs/${run.id}`,
    });
  });

  it("accepts every runnable mission and Autopilot", async () => {
    const { token } = await workspaceWithToken(app);
    const inputs: Record<(typeof MISSION_IDS)[number], Record<string, string>> = {
      "company-xray": { url: "acme.example" },
      "automation-audit": { url: "acme.example", department: "Support" },
      "build-agent": { url: "acme.example", goal: "Answer support questions" },
      "custom-goal": { goal: "Summarise the pricing page of acme.example" },
      "repo-xray": { url: "https://github.com/vercel/next.js", ref: "canary" },
      autopilot: { goal: "Find the best automation for acme.example and build it" },
    };
    for (const missionId of MISSION_IDS) {
      const run = await createRun(token, { missionId, input: inputs[missionId] });
      expect(run.mission, missionId).toBe(missionId);
    }
  });

  it("validates the body with stable codes and issue paths", async () => {
    const { token } = await workspaceWithToken(app);
    const cases: [SendOptions, number, string, RegExp?][] = [
      [
        { body: { missionId: "nope", input: { url: "acme.example" } } },
        400,
        "invalid_request",
        /^missionId:/,
      ],
      [{ body: { missionId: "company-xray", input: {} } }, 400, "invalid_request", /^input\.url:/],
      [
        { body: { missionId: "company-xray", input: { url: "acme.example", goal: "x y z" } } },
        400,
        "invalid_request",
        /^input\.goal:/,
      ],
      [{ body: { ...XRAY, extra: true } }, 400, "invalid_request"],
      [
        { body: { ...XRAY, parentRunId: "0d2f3c1e-3c5e-4d3c-9d55-6f1c3a529b10" } },
        400,
        "invalid_request",
        /^parentRunId:/,
      ],
      [{ rawBody: "{nope", headers: { "content-type": "application/json" } }, 400, "invalid_json"],
      [{ rawBody: "" }, 400, "invalid_request"],
      [
        { rawBody: JSON.stringify(XRAY), headers: { "content-type": "text/plain" } },
        415,
        "unsupported_media_type",
      ],
      [
        {
          body: {
            missionId: "company-xray",
            input: { url: "acme.example", focus: "x".repeat(400) },
            pad: "y".repeat(9_000),
          },
        },
        413,
        "payload_too_large",
      ],
      [
        { body: { missionId: "company-xray", input: { url: "http://127.0.0.1/admin" } } },
        400,
        "invalid_url",
      ],
      [
        { body: { missionId: "repo-xray", input: { url: "https://gitlab.com/a/b" } } },
        400,
        "invalid_url",
      ],
    ];
    for (const [options, status, code, issue] of cases) {
      const response = await send("POST", "/runs", { token, ...options });
      const error = await errorOf(response);
      expect([response.status, error.code], JSON.stringify(options).slice(0, 80)).toEqual([
        status,
        code,
      ]);
      if (issue !== undefined) expect(error.issues?.join("\n") ?? "").toMatch(issue);
    }
  });
});

describe("GET /api/v1/runs/:id and plan decisions", { timeout: 40_000 }, () => {
  it("follows a run to its deliverable through a plan approval", async () => {
    const { token } = await workspaceWithToken(app);
    const created = await createRun(token, AUDIT);
    const waiting = await waitFor(token, created.id, (run) => run.pendingPlan !== null);
    expect(waiting.status).toBe("awaiting_plan_approval");
    expect(waiting.pendingPlan?.length).toBeGreaterThan(0);
    expect(waiting.deliverable).toBeNull();

    const approved = await send("POST", `/runs/${created.id}/plan/approve`, { token });
    expect(approved.status).toBe(200);
    expect(PlanDecisionResultSchema.parse(await approved.json())).toEqual({
      runId: created.id,
      decision: "approved",
    });

    const done = await waitFor(token, created.id, (run) => run.terminal);
    expect(done.status).toBe("completed");
    expect(done.deliverable).toMatchObject({ kind: "automation-audit" });
    expect(done.steps.length).toBeGreaterThan(0);
    expect(done.finishedAt).not.toBeNull();
    expect(done.error).toBeNull();

    const again = await send("POST", `/runs/${created.id}/plan/approve`, { token });
    expect(again.status).toBe(409);
    expect((await errorOf(again)).code).toBe("run_finished");
  });

  it("rejects a plan with a reason and reports the run as failed", async () => {
    const { token } = await workspaceWithToken(app);
    const created = await createRun(token, AUDIT);
    await waitFor(token, created.id, (run) => run.pendingPlan !== null);
    const invalid = await send("POST", `/runs/${created.id}/plan/reject`, {
      token,
      body: { reason: "", other: 1 },
    });
    expect(invalid.status).toBe(400);
    const rejected = await send("POST", `/runs/${created.id}/plan/reject`, {
      token,
      body: { reason: "Too broad" },
    });
    expect(rejected.status).toBe(200);
    const done = await waitFor(token, created.id, (run) => run.terminal);
    expect(done).toMatchObject({ status: "failed", error: { code: "plan_rejected" } });
  });

  it("answers 409 no_pending_plan when nothing waits and 400 for a malformed id", async () => {
    const workspace = await workspaceWithToken(app);
    const { token } = workspace;
    const idle = await seedAssistant(workspace);
    for (const decision of ["approve", "reject"]) {
      const pending = await send("POST", `/runs/${idle.runId}/plan/${decision}`, { token });
      expect(pending.status).toBe(409);
      expect((await errorOf(pending)).code).toBe("no_pending_plan");
    }
    const malformed = await send("GET", "/runs/not-a-uuid", { token });
    expect(malformed.status).toBe(400);
    expect((await errorOf(malformed)).issues?.[0]).toMatch(/^runId:/);
    const missing = await send("GET", "/runs/0d2f3c1e-3c5e-4d3c-9d55-6f1c3a529b10", { token });
    expect(missing.status).toBe(404);
  });

  it("lists the children of an Autopilot run", async () => {
    const { token } = await workspaceWithToken(app);
    const created = await createRun(token, {
      missionId: "autopilot",
      input: { goal: "Audit acme.example and build the best assistant" },
    });
    const run = await getRun(token, created.id);
    expect(run.mission).toBe("autopilot");
    expect(Array.isArray(run.children)).toBe(true);
  });
});

describe("GET /api/v1/runs", () => {
  it("pages newest first with a cursor and filters by status", async () => {
    const { token } = await workspaceWithToken(app);
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) ids.push((await createRun(token, XRAY)).id);
    for (const id of ids) await waitFor(token, id, (run) => run.terminal);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = cursor === null ? "?limit=2" : `?limit=2&cursor=${cursor}`;
      const response = await send("GET", `/runs${query}`, { token });
      expect(response.status).toBe(200);
      const page = RunListSchema.parse(await response.json());
      expect(page.data.length).toBeLessThanOrEqual(2);
      seen.push(...page.data.map((run) => run.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null);
    expect(pages).toBe(3);
    expect(seen).toEqual([...ids].reverse());

    const completed = RunListSchema.parse(
      await (await send("GET", "/runs?status=completed", { token })).json(),
    );
    expect(completed.data.map((run) => run.id).sort()).toEqual([...ids].sort());
    expect(completed.data[0]).toMatchObject({
      mission: "company-xray",
      target: "acme.example",
      webUrl: `${TEST_ORIGIN}/runs/${completed.data[0]?.id ?? ""}`,
    });
    const failed = RunListSchema.parse(
      await (await send("GET", "/runs?status=failed", { token })).json(),
    );
    expect(failed).toEqual({ data: [], nextCursor: null });
  });

  it("rejects bad limits, forged cursors, unknown and repeated parameters", async () => {
    const { token } = await workspaceWithToken(app);
    const forged = Buffer.from(JSON.stringify(["2026-01-01", "x"])).toString("base64url");
    for (const query of [
      "?limit=0",
      "?limit=101",
      "?limit=abc",
      "?cursor=not-a-cursor",
      `?cursor=${forged}`,
      "?status=done",
      "?offset=3",
      "?limit=1&limit=2",
    ]) {
      const response = await send("GET", `/runs${query}`, { token });
      expect(response.status, query).toBe(400);
      expect((await errorOf(response)).code).toBe("invalid_request");
    }
  });

  it("lists only the token's workspace", async () => {
    const one = await workspaceWithToken(app);
    const two = await workspaceWithToken(app);
    const run = await createRun(one.token, XRAY);
    const other = RunListSchema.parse(
      await (await send("GET", "/runs", { token: two.token })).json(),
    );
    expect(other.data.map((entry) => entry.id)).not.toContain(run.id);
  });
});

describe("GET /api/v1/runs/:id/events", { timeout: 40_000 }, () => {
  it("pages JSON events with an after cursor until the log is exhausted", async () => {
    const { token } = await workspaceWithToken(app);
    const created = await createRun(token, XRAY);
    await waitFor(token, created.id, (run) => run.terminal);
    const seqs: number[] = [];
    let after = 0;
    for (;;) {
      const response = await send("GET", `/runs/${created.id}/events?after=${after}&limit=7`, {
        token,
      });
      expect(response.status).toBe(200);
      const page = RunEventPageSchema.parse(await response.json());
      expect(page.terminal).toBe(true);
      expect(page.data.length).toBeLessThanOrEqual(7);
      seqs.push(...page.data.map((event) => event.seq));
      expect(page.nextAfter).toBe(page.data.at(-1)?.seq ?? after);
      after = page.nextAfter;
      if (!page.hasMore) break;
    }
    expect(seqs.length).toBeGreaterThan(7);
    expect(seqs).toEqual(seqs.map((_seq, index) => index + 1));
    const tail = RunEventPageSchema.parse(
      await (await send("GET", `/runs/${created.id}/events?after=${after}`, { token })).json(),
    );
    expect(tail).toEqual({ data: [], nextAfter: after, hasMore: false, terminal: true });
  });

  it("validates after and limit", async () => {
    const { token } = await workspaceWithToken(app);
    const created = await createRun(token, XRAY);
    for (const query of ["?after=-1", "?limit=0", "?limit=501", "?after=x", "?before=3"]) {
      const response = await send("GET", `/runs/${created.id}/events${query}`, { token });
      expect(response.status, query).toBe(400);
    }
  });

  it("streams events over SSE, resumes from a sequence and ends with 204", async () => {
    const { token } = await workspaceWithToken(app);
    const created = await createRun(token, XRAY);
    const sse = { accept: "text/event-stream" };
    const response = await send("GET", `/runs/${created.id}/events`, { token, headers: sse });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get(REQUEST_ID_HEADER)).toMatch(/^req_/);
    if (response.body === null) throw new Error("no stream");
    const types: string[] = [];
    let last = 0;
    for await (const message of parseSse(response.body)) {
      if (message.event.startsWith("stream.")) continue;
      types.push(message.event);
      last = Number(message.id);
    }
    expect(types[0]).toBe("run.created");
    expect(types.at(-1)).toBe("run.completed");

    const resumed = await send("GET", `/runs/${created.id}/events?after=${last - 2}`, {
      token,
      headers: sse,
    });
    if (resumed.body === null) throw new Error("no stream");
    const replayed: number[] = [];
    for await (const message of parseSse(resumed.body))
      if (!message.event.startsWith("stream.")) replayed.push(Number(message.id));
    expect(replayed).toEqual([last - 1, last]);

    const finished = await send("GET", `/runs/${created.id}/events`, {
      token,
      headers: { ...sse, "last-event-id": String(last) },
    });
    expect(finished.status).toBe(204);
  });
});

describe("POST /api/v1/runs/:id/cancel", () => {
  it("cancels a waiting run once and then answers 409 run_finished", async () => {
    const { token } = await workspaceWithToken(app);
    const created = await createRun(token, AUDIT);
    await waitFor(token, created.id, (run) => run.pendingPlan !== null);
    const response = await send("POST", `/runs/${created.id}/cancel`, { token });
    expect(response.status).toBe(200);
    const run = RunSchema.parse(await response.json());
    expect(run).toMatchObject({ status: "failed", terminal: true, error: { code: "cancelled" } });
    const again = await send("POST", `/runs/${created.id}/cancel`, { token });
    expect(again.status).toBe(409);
    expect((await errorOf(again)).code).toBe("run_finished");
  });
});

describe("v1 artifacts", () => {
  it("lists references and fetches one artifact with its content", async () => {
    const { token } = await workspaceWithToken(app);
    const created = await createRun(token, XRAY);
    await waitFor(token, created.id, (run) => run.terminal);
    const listed = ArtifactListSchema.parse(
      await (await send("GET", `/runs/${created.id}/artifacts`, { token })).json(),
    );
    expect(listed.data.length).toBeGreaterThan(0);
    const brief = listed.data.find((artifact) => artifact.kind === "company-xray-brief");
    if (brief === undefined) throw new Error("the simulated run has no brief");
    expect(brief.version).toBeGreaterThan(1);
    const response = await send("GET", `/runs/${created.id}/artifacts/${brief.artifactId}`, {
      token,
    });
    expect(response.status).toBe(200);
    const artifact = ArtifactSchema.parse(await response.json());
    expect(artifact).toMatchObject({ artifactId: brief.artifactId, version: brief.version });
    expect(artifact.content).not.toBeNull();
    const missing = await send("GET", `/runs/${created.id}/artifacts/nope`, { token });
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).message).toContain("artifact");
  });
});

const ASSISTANT_ID = "6f1c3a52-3c5e-4d3c-9d55-0d2f3c1e9b10";

async function seedAssistant(workspace: Awaited<ReturnType<typeof workspaceWithToken>>) {
  const { runId } = await createRunRecord(app, workspace.session, {
    missionId: "build-agent",
    input: { url: "https://acme.example/", goal: "Answer support questions" },
    execution: "simulated",
  });
  const id = crypto.randomUUID();
  await appendEvent(
    app,
    { runId, workspaceId: workspace.session.workspaceId, userId: workspace.session.userId },
    {
      type: "artifact.created",
      payload: {
        artifactId: "assistant",
        kind: "assistant",
        title: "Acme helper",
        version: 1,
        content: {
          id,
          name: "Acme helper",
          url: "https://acme.example/",
          collection: `assistant-${id}`,
          goal: "Answer support questions",
          systemPrompt: "Answer from the sources only.",
          persona: "Helpful and brief.",
          scope: { covers: ["Support"], excludes: [] },
          refusalPolicy: "Decline when the sources do not say.",
          starterQuestions: ["How do I reset my password?"],
          corpusStats: {
            pages: 12,
            chunks: 80,
            flaggedChunks: 0,
            embeddedChunks: 0,
            tokens: 9_000,
            bytes: 40_000,
            skippedPages: 1,
          },
          retrieval: { mode: "full-text", rerank: false },
          modelChain: { answer: [], rerank: [] },
          prompts: { answer: 1 },
          passRate: 0.9,
          status: "ready",
        },
      },
    },
  );
  return { id, runId };
}

describe("v1 assistants", () => {
  it("lists the workspace's assistants", async () => {
    const workspace = await workspaceWithToken(app);
    const empty = AssistantListSchema.parse(
      await (await send("GET", "/assistants", { token: workspace.token })).json(),
    );
    expect(empty.data).toEqual([]);
    const seeded = await seedAssistant(workspace);
    const listed = AssistantListSchema.parse(
      await (await send("GET", "/assistants?limit=5", { token: workspace.token })).json(),
    );
    expect(listed.data).toEqual([
      expect.objectContaining({
        id: seeded.id,
        name: "Acme helper",
        status: "ready",
        passRate: 0.9,
        pages: 12,
        runId: seeded.runId,
        webUrl: `${TEST_ORIGIN}/agents/${seeded.id}`,
      }),
    ]);
    const bad = await send("GET", "/assistants?limit=500", { token: workspace.token });
    expect(bad.status).toBe(400);
  });

  it("answers a question as JSON and as an event stream", async () => {
    const workspace = await workspaceWithToken(app);
    const seeded = await seedAssistant(workspace);
    const response = await send("POST", `/assistants/${seeded.id}/chat`, {
      token: workspace.token,
      body: { question: "Do you ship?" },
    });
    expect(response.status).toBe(200);
    const answer = ChatAnswerSchema.parse(await response.json());
    expect(answer).toMatchObject({
      answer: "Answer to Do you ship? [1].",
      grounded: true,
      refused: false,
      refusal: null,
      citations: [{ index: 1, chunkId: "k1", url: "https://acme.example/a" }],
    });
    expect(JSON.stringify(answer)).not.toContain("retrieval");

    const stream = await send("POST", `/assistants/${seeded.id}/chat`, {
      token: workspace.token,
      body: { question: "Do you ship?" },
      headers: { accept: "text/event-stream" },
    });
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    expect(await stream.text()).toContain("event: delta\n");
  });

  it("validates the question, hides other workspaces' assistants and applies the quota", async () => {
    const workspace = await workspaceWithToken(app);
    const stranger = await workspaceWithToken(app);
    const seeded = await seedAssistant(workspace);
    const path = `/assistants/${seeded.id}/chat`;
    for (const body of [
      {},
      { question: "" },
      { question: "x".repeat(1_001) },
      { question: "q", history: "no" },
    ]) {
      const response = await send("POST", path, { token: workspace.token, body });
      expect(response.status, JSON.stringify(body).slice(0, 40)).toBe(400);
    }
    const hidden = await send("POST", path, { token: stranger.token, body: { question: "hi" } });
    expect(hidden.status).toBe(404);
    const unknown = await send("POST", `/assistants/${ASSISTANT_ID}/chat`, {
      token: workspace.token,
      body: { question: "hi" },
    });
    expect(unknown.status).toBe(404);

    const base = deps();
    const tight = {
      ...base,
      chat: { ...base.chat, limiter: createRateLimiter({ limit: 1, windowMs: 60_000 }) },
    };
    const ask = () =>
      send("POST", path, { token: workspace.token, body: { question: "hi" } }, tight);
    expect((await ask()).status).toBe(200);
    const refused = await ask();
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("maps an unavailable model to 503 unavailable", async () => {
    const workspace = await workspaceWithToken(app);
    const seeded = await seedAssistant(workspace);
    const base = deps();
    const down: V1Deps = {
      ...base,
      chat: {
        ...base.chat,
        answer: async function* () {
          await Promise.resolve();
          yield { type: "refusal", reason: "unavailable", message: "No model is reachable." };
          yield {
            type: "done",
            answer: "",
            citations: [],
            grounded: false,
            refused: true,
            usage: { inputTokens: 0, outputTokens: 0 },
            retrieval: { mode: "full-text", candidates: 0, used: 0, reranked: false },
            durationMs: 1,
          };
        },
      },
    };
    const response = await send(
      "POST",
      `/assistants/${seeded.id}/chat`,
      { token: workspace.token, body: { question: "hi" } },
      down,
    );
    expect(response.status).toBe(503);
    expect((await errorOf(response)).code).toBe("unavailable");
  });
});

describe("v1 workspace isolation", () => {
  it("answers 404 to another workspace's token on every run operation", async () => {
    const owner = await workspaceWithToken(app);
    const intruder = await workspaceWithToken(app);
    const run = await createRun(owner.token, AUDIT);
    await waitFor(owner.token, run.id, (current) => current.pendingPlan !== null);
    const calls: ["GET" | "POST", string, Record<string, string>?][] = [
      ["GET", `/runs/${run.id}`],
      ["GET", `/runs/${run.id}/events`],
      ["GET", `/runs/${run.id}/events`, { accept: "text/event-stream" }],
      ["GET", `/runs/${run.id}/artifacts`],
      ["GET", `/runs/${run.id}/artifacts/audit`],
      ["POST", `/runs/${run.id}/cancel`],
      ["POST", `/runs/${run.id}/plan/approve`],
      ["POST", `/runs/${run.id}/plan/reject`],
    ];
    for (const [method, path, headers] of calls) {
      const response = await send(method, path, {
        token: intruder.token,
        ...(headers === undefined ? {} : { headers }),
      });
      expect(response.status, `${method} ${path}`).toBe(404);
      const body = JSON.stringify(await response.json());
      expect(body).not.toContain("acme");
    }
    const still = await getRun(owner.token, run.id);
    expect(still.status).toBe("awaiting_plan_approval");
    const child = await send("POST", "/runs", {
      token: intruder.token,
      body: {
        missionId: "build-agent",
        input: { url: "acme.example", goal: "Answer questions" },
        parentRunId: run.id,
      },
    });
    expect(child.status).toBe(400);
  });
});

describe("v1 idempotency", { timeout: 40_000 }, () => {
  const key = () => `key-${crypto.randomUUID()}`;

  it("replays the first response for a repeated key and creates one run", async () => {
    const { token } = await workspaceWithToken(app);
    const idempotencyKey = key();
    const headers = { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey };
    const first = await send("POST", "/runs", { token, body: XRAY, headers });
    expect(first.status).toBe(201);
    expect(first.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBeNull();
    const firstBody = await first.text();
    const second = await send("POST", "/runs", { token, body: XRAY, headers });
    expect(second.status).toBe(201);
    expect(second.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBe("true");
    expect(await second.text()).toBe(firstBody);
    expect(second.headers.get(REQUEST_ID_HEADER)).not.toBe(first.headers.get(REQUEST_ID_HEADER));
    const listed = RunListSchema.parse(await (await send("GET", "/runs", { token })).json());
    expect(listed.data).toHaveLength(1);
  });

  it("answers 422 when the key is reused with a different request", async () => {
    const { token } = await workspaceWithToken(app);
    const headers = { [IDEMPOTENCY_KEY_HEADER]: key() };
    expect((await send("POST", "/runs", { token, body: XRAY, headers })).status).toBe(201);
    const other = await send("POST", "/runs", { token, body: AUDIT, headers });
    expect(other.status).toBe(422);
    expect((await errorOf(other)).code).toBe("idempotency_key_reused");
    const run = await createRun(token, AUDIT);
    const elsewhere = await send("POST", `/runs/${run.id}/cancel`, { token, headers });
    expect(elsewhere.status).toBe(422);
  });

  it("rejects malformed keys before doing anything", async () => {
    const { token } = await workspaceWithToken(app);
    for (const bad of ["", "has space", "x".repeat(256), "café"]) {
      const response = await send("POST", "/runs", {
        token,
        body: XRAY,
        headers: { [IDEMPOTENCY_KEY_HEADER]: bad },
      });
      expect(response.status, bad.slice(0, 10)).toBe(400);
      expect((await errorOf(response)).code).toBe("invalid_idempotency_key");
    }
    const listed = RunListSchema.parse(await (await send("GET", "/runs", { token })).json());
    expect(listed.data).toEqual([]);
  });

  it("does not store failures: the key can be retried after a 4xx", async () => {
    const { token } = await workspaceWithToken(app);
    const headers = { [IDEMPOTENCY_KEY_HEADER]: key() };
    const body = { missionId: "company-xray", input: { url: "http://127.0.0.1/" } };
    const failed = await send("POST", "/runs", { token, body, headers });
    expect(failed.status).toBe(400);
    const again = await send("POST", "/runs", { token, body, headers });
    expect(again.status).toBe(400);
    expect(again.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBeNull();
  });

  it("lets only one of two concurrent requests with one key create the run", async () => {
    const { token } = await workspaceWithToken(app);
    const headers = { [IDEMPOTENCY_KEY_HEADER]: key() };
    const responses = await Promise.all(
      [0, 1, 2].map(() => send("POST", "/runs", { token, body: XRAY, headers })),
    );
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses.filter((status) => status === 201).length).toBeGreaterThanOrEqual(1);
    for (const response of responses) {
      if (response.status === 201) continue;
      expect(response.status).toBe(409);
      expect(response.headers.get("retry-after")).toBe("2");
      expect((await errorOf(response)).code).toBe("idempotency_in_progress");
    }
    const listed = RunListSchema.parse(await (await send("GET", "/runs", { token })).json());
    expect(listed.data).toHaveLength(1);
  });

  it("scopes keys to the workspace: the same key elsewhere is a new request", async () => {
    const one = await workspaceWithToken(app);
    const two = await workspaceWithToken(app);
    const headers = { [IDEMPOTENCY_KEY_HEADER]: key() };
    const first = await send("POST", "/runs", { token: one.token, body: XRAY, headers });
    const firstRun = RunSchema.parse(await first.json());
    const second = await send("POST", "/runs", { token: two.token, body: XRAY, headers });
    expect(second.status).toBe(201);
    expect(second.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBeNull();
    const secondRun = RunSchema.parse(await second.json());
    expect(secondRun.id).not.toBe(firstRun.id);
    expect((await send("GET", `/runs/${firstRun.id}`, { token: two.token })).status).toBe(404);
  });

  it("replays plan decisions and cancellations instead of answering 409", async () => {
    const { token } = await workspaceWithToken(app);
    const run = await createRun(token, AUDIT);
    await waitFor(token, run.id, (current) => current.pendingPlan !== null);
    const headers = { [IDEMPOTENCY_KEY_HEADER]: key() };
    const first = await send("POST", `/runs/${run.id}/cancel`, { token, headers });
    expect(first.status).toBe(200);
    const second = await send("POST", `/runs/${run.id}/cancel`, { token, headers });
    expect(second.status).toBe(200);
    expect(second.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBe("true");
  });

  it("refuses to combine a key with a streamed answer", async () => {
    const workspace = await workspaceWithToken(app);
    const seeded = await seedAssistant(workspace);
    const response = await send("POST", `/assistants/${seeded.id}/chat`, {
      token: workspace.token,
      body: { question: "hi" },
      headers: { accept: "text/event-stream", [IDEMPOTENCY_KEY_HEADER]: key() },
    });
    expect(response.status).toBe(400);
  });
});

describe("the unversioned routes", () => {
  it("still start runs for cookie sessions with their own response shape", async () => {
    const response = await handleCreateRun(
      new Request(`${TEST_ORIGIN}/api/runs`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: TEST_ORIGIN,
          host: "delegate.example",
        },
        body: JSON.stringify(XRAY),
      }),
      testApiDeps(app, background),
    );
    expect(response.status).toBe(201);
    expect(Object.keys((await response.json()) as object)).toContain("runId");
  });
});
