import { webhookEndpoints, withTenant } from "@delegate/db";
import {
  isKnownWebhookEvent,
  verifyWebhook,
  WEBHOOK_HEADERS,
  WEBHOOK_SECRET_PREFIX,
  WebhookVerificationError,
} from "@delegate/sdk";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { startRunForSession } from "../api";
import { type AppDatabase, createPgliteAppDatabase } from "../db";
import { createRateLimiter, type GuestSession, SESSION_COOKIE, signSession } from "../session";
import {
  createBackground,
  createTestWebhooks,
  dispatchV1,
  TEST_ORIGIN,
  TEST_SESSION_SECRET,
  testApiDeps,
  type TestWebhooks,
  testV1Deps,
  v1Request,
  workspaceWithToken,
} from "../v1/testing";
import { flushDueDeliveries, flushSoon, resetFlushThrottle } from "./dispatch";
import { WEBHOOK_ENCRYPTION_KEY_MISSING_MESSAGE } from "./endpoints";
import {
  MAX_WEBHOOK_ENDPOINTS,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_DELAYS_MS,
  WEBHOOK_TESTS_PER_MINUTE,
} from "./policy";
import { configureWebhooks } from "./runtime";
import {
  handleAddWebhookEndpoint,
  handleDeleteWebhookEndpoint,
  handleRotateWebhookSecret,
  handleTestWebhookEndpoint,
  handleWebhooksOverview,
  type WebhookSettingsDeps,
} from "./settings-api";
import type { WebhookSendOutcome } from "./transport";

let app: AppDatabase;
const background = createBackground();
let hooks: TestWebhooks;

beforeAll(async () => {
  app = await createPgliteAppDatabase();
});

beforeEach(() => {
  hooks = createTestWebhooks(background);
  hooks.clock.now = new Date();
  configureWebhooks(hooks.runtime);
  resetFlushThrottle();
});

afterAll(async () => {
  await background.stop();
  configureWebhooks(null);
  await app.close();
});

function settingsDeps(overrides: Partial<WebhookSettingsDeps> = {}): WebhookSettingsDeps {
  return {
    api: testApiDeps(app, background),
    testLimiter: createRateLimiter({ limit: WEBHOOK_TESTS_PER_MINUTE, windowMs: 60_000 }),
    ...overrides,
  };
}

interface Caller {
  session?: GuestSession;
  origin?: string;
  bearer?: string;
}

function settingsRequest(method: string, path: string, caller: Caller, body?: unknown): Request {
  return new Request(`${TEST_ORIGIN}/settings/webhooks/endpoints${path}`, {
    method,
    headers: {
      host: "delegate.example",
      origin: caller.origin ?? TEST_ORIGIN,
      ...(caller.session === undefined
        ? {}
        : { cookie: `${SESSION_COOKIE}=${signSession(caller.session, TEST_SESSION_SECRET)}` }),
      ...(caller.bearer === undefined ? {} : { authorization: `Bearer ${caller.bearer}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const EndpointSchema = z.object({
  id: z.uuid(),
  url: z.string(),
  host: z.string(),
  description: z.string(),
  events: z.array(z.string()),
  createdAt: z.string(),
  secretRotatedAt: z.string().nullable(),
});
const CreatedSchema = z.strictObject({ endpoint: EndpointSchema.strict(), secret: z.string() });
const DeliverySchema = z.object({
  id: z.uuid(),
  endpointId: z.uuid(),
  runId: z.uuid().nullable(),
  eventType: z.string(),
  status: z.enum(["pending", "delivered", "failed"]),
  attempts: z.number(),
  lastStatusCode: z.number().nullable(),
  lastError: z.string().nullable(),
  lastResponseExcerpt: z.string().nullable(),
  nextAttemptAt: z.string().nullable(),
});
const OverviewSchema = z.object({
  endpoints: z.array(EndpointSchema),
  deliveries: z.array(DeliverySchema),
  encryptionConfigured: z.boolean(),
  maxEndpoints: z.number(),
  maxAttempts: z.number(),
  eventTypes: z.array(z.object({ type: z.string(), meaning: z.string() })),
});
const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

const ALL_EVENTS = ["run.completed", "run.failed", "run.cancelled", "approval.requested"];

async function addEndpoint(
  session: GuestSession,
  url = "https://hooks.example.com/delegate",
  events: string[] = ALL_EVENTS,
) {
  const response = await handleAddWebhookEndpoint(
    settingsRequest("POST", "", { session }, { url, events }),
    settingsDeps(),
  );
  expect(response.status).toBe(201);
  return CreatedSchema.parse(await response.json());
}

async function overview(session: GuestSession) {
  const response = await handleWebhooksOverview(
    settingsRequest("GET", "", { session }),
    settingsDeps(),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return OverviewSchema.parse(await response.json());
}

async function startRun(token: string, body: unknown): Promise<string> {
  const response = await dispatchV1(
    v1Request("POST", "/runs", { token, body }),
    testV1Deps(app, background),
  );
  expect(response.status).toBe(201);
  return z.object({ id: z.uuid() }).parse(await response.json()).id;
}

async function runStatus(token: string, runId: string) {
  const response = await dispatchV1(
    v1Request("GET", `/runs/${runId}`, { token }),
    testV1Deps(app, background),
  );
  return z
    .object({ status: z.string(), terminal: z.boolean(), pendingPlan: z.unknown() })
    .parse(await response.json());
}

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

const XRAY = { missionId: "company-xray", input: { url: "acme.example" } };
const AUDIT = { missionId: "automation-audit", input: { url: "acme.example" } };

const DUE_MARGIN_MS = 750;

function failOnceThenBecomeDue(outcome: WebhookSendOutcome): void {
  hooks.respond = () => {
    hooks.clock.now = new Date(Date.now() - WEBHOOK_RETRY_DELAYS_MS[0] + DUE_MARGIN_MS);
    return outcome;
  };
}

async function untilDue(session: GuestSession): Promise<void> {
  const [delivery] = (await overview(session)).deliveries;
  const due = Date.parse(delivery?.nextAttemptAt ?? "");
  await until(() => Date.now() > due + 50, "the retry to become due");
}

function sentOf(type: string) {
  return hooks.sent.filter((request) => request.headers[WEBHOOK_HEADERS.event] === type);
}

async function verified(request: (typeof hooks.sent)[number], secret: string) {
  const event = await verifyWebhook({
    payload: request.body,
    headers: request.headers,
    secret,
    now: () => request.at.getTime(),
  });
  if (!isKnownWebhookEvent(event)) throw new Error("unknown event type");
  return event;
}

describe("webhook settings", () => {
  it("adds an endpoint, shows the secret once and stores it encrypted", async () => {
    const { session } = await workspaceWithToken(app);
    const created = await addEndpoint(session, "https://hooks.example.com/delegate#frag", [
      "run.failed",
      "run.completed",
    ]);
    expect(created.secret).toMatch(new RegExp(`^${WEBHOOK_SECRET_PREFIX}[A-Za-z0-9_-]{43}$`));
    expect(created.endpoint).toMatchObject({
      url: "https://hooks.example.com/delegate",
      host: "hooks.example.com",
      events: ["run.completed", "run.failed"],
      secretRotatedAt: null,
    });
    const listed = await overview(session);
    expect(listed.endpoints.map((endpoint) => endpoint.id)).toEqual([created.endpoint.id]);
    expect(JSON.stringify(listed)).not.toContain(created.secret);
    expect(listed).toMatchObject({
      encryptionConfigured: true,
      maxEndpoints: MAX_WEBHOOK_ENDPOINTS,
      maxAttempts: WEBHOOK_MAX_ATTEMPTS,
    });
    expect(listed.eventTypes.map((entry) => entry.type)).toEqual(ALL_EVENTS);
    expect(hooks.sealed).toHaveLength(1);
    expect(hooks.sealed[0]).toMatch(/^v1\./);
    expect(hooks.sealed[0]).not.toContain(created.secret.slice(WEBHOOK_SECRET_PREFIX.length));
    const byId = eq(webhookEndpoints.id, created.endpoint.id);
    const [row] = await withTenant(app.db, session.userId, (tx) =>
      tx.select({ origin: webhookEndpoints.origin }).from(webhookEndpoints).where(byId),
    );
    expect(row?.origin).toBe(TEST_ORIGIN);
    await expect(
      withTenant(app.db, session.userId, (tx) =>
        tx.select({ sealed: webhookEndpoints.secretCiphertext }).from(webhookEndpoints).where(byId),
      ),
    ).rejects.toThrow();
  });

  it("refuses private, loopback, link-local and metadata targets and plain http", async () => {
    const { session } = await workspaceWithToken(app);
    hooks.dns.set("internal.example.com", ["10.2.3.4"]);
    hooks.dns.set("mixed.example.com", ["93.184.215.14", "169.254.169.254"]);
    hooks.dns.set("gone.example.com", []);
    for (const url of [
      "https://10.0.0.5/hook",
      "https://127.0.0.1/hook",
      "https://[::1]/hook",
      "https://169.254.169.254/latest/meta-data/",
      "https://localhost/hook",
      "https://metadata.google.internal/",
      "http://hooks.example.com/hook",
      `https://${["user", "pw"].join(":")}@hooks.example.com/hook`,
      "https://hooks.example.com:8443/hook",
      "https://internal.example.com/hook",
      "https://mixed.example.com/hook",
      "https://gone.example.com/hook",
    ]) {
      const response = await handleAddWebhookEndpoint(
        settingsRequest("POST", "", { session }, { url, events: ALL_EVENTS }),
        settingsDeps(),
      );
      expect(response.status, url).toBe(400);
      expect(ErrorSchema.parse(await response.json()).error.code, url).toBe("invalid_url");
    }
    expect((await overview(session)).endpoints).toEqual([]);
  });

  it("validates the body, refuses duplicates and caps endpoints per workspace", async () => {
    const { session } = await workspaceWithToken(app);
    for (const body of [
      {},
      { url: "https://hooks.example.com/a", events: [] },
      { url: "https://hooks.example.com/a", events: ["run.started"] },
      { url: "https://hooks.example.com/a", events: ALL_EVENTS, secret: "mine" },
      { url: "https://hooks.example.com/a", events: ALL_EVENTS, description: "x".repeat(121) },
    ]) {
      const response = await handleAddWebhookEndpoint(
        settingsRequest("POST", "", { session }, body),
        settingsDeps(),
      );
      expect(response.status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    for (let index = 0; index < MAX_WEBHOOK_ENDPOINTS; index += 1)
      await addEndpoint(session, `https://hooks.example.com/${index}`);
    const duplicate = await handleAddWebhookEndpoint(
      settingsRequest(
        "POST",
        "",
        { session },
        { url: "https://hooks.example.com/0", events: ALL_EVENTS },
      ),
      settingsDeps(),
    );
    expect(duplicate.status).toBe(409);
    const tooMany = await handleAddWebhookEndpoint(
      settingsRequest(
        "POST",
        "",
        { session },
        { url: "https://hooks.example.com/more", events: ALL_EVENTS },
      ),
      settingsDeps(),
    );
    expect(tooMany.status).toBe(409);
    expect(ErrorSchema.parse(await tooMany.json()).error.message).toContain("at most");
  });

  it("refuses to create endpoints without DELEGATE_ENCRYPTION_KEY, with a clear message", async () => {
    const { session } = await workspaceWithToken(app);
    configureWebhooks(createTestWebhooks(background, { encryption: false }).runtime);
    const response = await handleAddWebhookEndpoint(
      settingsRequest(
        "POST",
        "",
        { session },
        { url: "https://hooks.example.com/a", events: ALL_EVENTS },
      ),
      settingsDeps(),
    );
    expect(response.status).toBe(503);
    const error = ErrorSchema.parse(await response.json()).error;
    expect(error.message).toBe(WEBHOOK_ENCRYPTION_KEY_MISSING_MESSAGE);
    expect(error.message).toContain("DELEGATE_ENCRYPTION_KEY");
    const listed = await overview(session);
    expect(listed.encryptionConfigured).toBe(false);
    expect(listed.endpoints).toEqual([]);
  });

  it("is cookie-only and same-origin: bearer tokens and other origins are refused", async () => {
    const { session, token } = await workspaceWithToken(app);
    const created = await addEndpoint(session);
    const body = { url: "https://hooks.example.com/b", events: ALL_EVENTS };
    const id = created.endpoint.id;
    const attempts: [string, Promise<Response>][] = [
      [
        "bearer add",
        handleAddWebhookEndpoint(
          settingsRequest("POST", "", { bearer: token }, body),
          settingsDeps(),
        ),
      ],
      [
        "bearer list",
        handleWebhooksOverview(settingsRequest("GET", "", { bearer: token }), settingsDeps()),
      ],
      [
        "bearer delete",
        handleDeleteWebhookEndpoint(
          settingsRequest("DELETE", `/${id}`, { bearer: token }),
          id,
          settingsDeps(),
        ),
      ],
      [
        "bearer rotate",
        handleRotateWebhookSecret(
          settingsRequest("POST", `/${id}/rotate`, { bearer: token }),
          id,
          settingsDeps(),
        ),
      ],
      [
        "bearer test",
        handleTestWebhookEndpoint(
          settingsRequest("POST", `/${id}/test`, { bearer: token }),
          id,
          settingsDeps(),
        ),
      ],
      [
        "cross-origin add",
        handleAddWebhookEndpoint(
          settingsRequest("POST", "", { session, origin: "https://evil.example" }, body),
          settingsDeps(),
        ),
      ],
      [
        "cross-origin delete",
        handleDeleteWebhookEndpoint(
          settingsRequest("DELETE", `/${id}`, { session, origin: "https://evil.example" }),
          id,
          settingsDeps(),
        ),
      ],
      [
        "cross-origin rotate",
        handleRotateWebhookSecret(
          settingsRequest("POST", `/${id}/rotate`, { session, origin: "https://evil.example" }),
          id,
          settingsDeps(),
        ),
      ],
      [
        "cross-origin test",
        handleTestWebhookEndpoint(
          settingsRequest("POST", `/${id}/test`, { session, origin: "https://evil.example" }),
          id,
          settingsDeps(),
        ),
      ],
    ];
    for (const [what, pending] of attempts) expect((await pending).status, what).toBe(403);
    expect((await overview(session)).endpoints).toHaveLength(1);
    expect(hooks.sent).toEqual([]);
  });

  it("starts a session for a first visitor and lists nothing without one", async () => {
    const anonymous = await handleWebhooksOverview(settingsRequest("GET", "", {}), settingsDeps());
    expect(OverviewSchema.parse(await anonymous.json()).endpoints).toEqual([]);
    const response = await handleAddWebhookEndpoint(
      settingsRequest(
        "POST",
        "",
        {},
        { url: "https://hooks.example.com/first", events: ALL_EVENTS },
      ),
      settingsDeps(),
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("set-cookie")).toContain(`${SESSION_COOKIE}=`);
  });

  it("hides one workspace's endpoints and deliveries from another", async () => {
    const owner = await workspaceWithToken(app);
    const stranger = await workspaceWithToken(app);
    const created = await addEndpoint(owner.session);
    const id = created.endpoint.id;
    const runId = await startRun(owner.token, XRAY);
    await until(async () => (await runStatus(owner.token, runId)).terminal, "the run to finish");
    await background.settle();
    expect((await overview(owner.session)).deliveries).toHaveLength(1);
    const seen = await overview(stranger.session);
    expect(seen.endpoints).toEqual([]);
    expect(seen.deliveries).toEqual([]);
    const caller = { session: stranger.session };
    const attempts = [
      handleDeleteWebhookEndpoint(settingsRequest("DELETE", `/${id}`, caller), id, settingsDeps()),
      handleRotateWebhookSecret(
        settingsRequest("POST", `/${id}/rotate`, caller),
        id,
        settingsDeps(),
      ),
      handleTestWebhookEndpoint(settingsRequest("POST", `/${id}/test`, caller), id, settingsDeps()),
      handleDeleteWebhookEndpoint(
        settingsRequest("DELETE", "/nope", caller),
        "nope",
        settingsDeps(),
      ),
    ];
    for (const pending of attempts) expect((await pending).status).toBe(404);
    expect((await overview(owner.session)).endpoints).toHaveLength(1);
    expect(
      await flushDueDeliveries(app, {
        workspaceId: owner.session.workspaceId,
        userId: stranger.session.userId,
      }),
    ).toMatchObject({ claimed: 0 });
  });
});

describe("webhook deliveries", { timeout: 40_000 }, () => {
  it("signs run.completed with the endpoint's secret and records the delivery", async () => {
    const { session, token } = await workspaceWithToken(app);
    const created = await addEndpoint(session);
    const runId = await startRun(token, XRAY);
    await until(() => sentOf("run.completed").length === 1, "the delivery");
    await background.settle();
    const [request] = sentOf("run.completed");
    if (request === undefined) throw new Error("no delivery");
    expect(request.url).toBe("https://hooks.example.com/delegate");
    expect(request.headers).toMatchObject({
      "content-type": "application/json",
      [WEBHOOK_HEADERS.event]: "run.completed",
    });
    expect(request.headers["user-agent"]).toMatch(/^Delegate-Webhooks\//);
    expect(request.headers[WEBHOOK_HEADERS.signature]).toMatch(/^v1=[0-9a-f]{64}$/);
    const event = await verified(request, created.secret);
    expect(event.id).toBe(request.headers[WEBHOOK_HEADERS.delivery]);
    expect(event).toMatchObject({
      type: "run.completed",
      apiVersion: "v1",
      data: {
        run: {
          id: runId,
          mission: "company-xray",
          target: "acme.example",
          status: "completed",
          error: null,
          url: `${TEST_ORIGIN}/runs/${runId}`,
        },
      },
    });
    if (event.type !== "run.completed") throw new Error("wrong type");
    expect(event.data.run.summary).not.toBeNull();
    expect(event.data.run.finishedAt).not.toBeNull();
    await expect(verified(request, `${created.secret}x`)).rejects.toThrow(WebhookVerificationError);
    await expect(
      verifyWebhook({
        payload: request.body,
        headers: request.headers,
        secret: created.secret,
        now: () => request.at.getTime() + 301_000,
      }),
    ).rejects.toMatchObject({ reason: "timestamp_out_of_tolerance" });

    const { deliveries } = await overview(session);
    expect(deliveries).toEqual([
      expect.objectContaining({
        id: event.id,
        endpointId: created.endpoint.id,
        runId,
        eventType: "run.completed",
        status: "delivered",
        attempts: 1,
        lastStatusCode: 200,
        lastError: null,
        nextAttemptAt: null,
      }),
    ]);
  });

  it("sends run.failed and run.cancelled only to endpoints subscribed to them", async () => {
    const { session, token } = await workspaceWithToken(app);
    await addEndpoint(session, "https://hooks.example.com/failures", ["run.failed"]);
    await addEndpoint(session, "https://hooks.example.com/cancels", ["run.cancelled"]);
    const failed = await startRun(token, {
      missionId: "custom-goal",
      input: { goal: "Summarise acme.example" },
    });
    await until(() => sentOf("run.failed").length === 1, "run.failed");
    const cancelled = await startRun(token, AUDIT);
    await until(async () => (await runStatus(token, cancelled)).pendingPlan !== null, "the plan");
    await dispatchV1(
      v1Request("POST", `/runs/${cancelled}/cancel`, { token }),
      testV1Deps(app, background),
    );
    await until(() => sentOf("run.cancelled").length === 1, "run.cancelled");
    const completed = await startRun(token, XRAY);
    await until(async () => (await runStatus(token, completed)).terminal, "the third run");
    await background.settle();
    expect(
      hooks.sent.map((request) => [request.url, request.headers[WEBHOOK_HEADERS.event]]),
    ).toEqual([
      ["https://hooks.example.com/failures", "run.failed"],
      ["https://hooks.example.com/cancels", "run.cancelled"],
    ]);
    const body = z
      .object({
        data: z.object({
          run: z.object({ id: z.string(), error: z.object({ code: z.string() }) }),
        }),
      })
      .parse(JSON.parse(hooks.sent[1]?.body ?? "null"));
    expect(body.data.run).toMatchObject({ id: cancelled, error: { code: "cancelled" } });
    expect(JSON.parse(hooks.sent[0]?.body ?? "null")).toMatchObject({
      data: { run: { id: failed, status: "failed", error: { code: "simulated_unsupported" } } },
    });
  });

  it("sends approval.requested when a plan waits for a human, not when it is auto-approved", async () => {
    const { session, token } = await workspaceWithToken(app);
    const created = await addEndpoint(session, "https://hooks.example.com/approvals", [
      "approval.requested",
    ]);
    const waiting = await startRun(token, AUDIT);
    await until(() => sentOf("approval.requested").length === 1, "approval.requested");
    const [request] = sentOf("approval.requested");
    if (request === undefined) throw new Error("no delivery");
    const event = await verified(request, created.secret);
    if (event.type !== "approval.requested") throw new Error("wrong type");
    expect(event.data.approval).toMatchObject({
      kind: "plan",
      url: `${TEST_ORIGIN}/runs/${waiting}`,
    });
    expect(event.data.approval.summary).toMatch(/plan with \d+ steps/);
    expect(event.data.run).toMatchObject({ id: waiting, status: "awaiting_plan_approval" });

    const started = await startRunForSession(
      app,
      session,
      { missionId: "automation-audit", input: { url: "acme.example" } },
      testApiDeps(app, background),
      { autoApprovePlan: true },
    );
    if (!started.ok) throw new Error("the run did not start");
    await until(
      async () => (await runStatus(token, started.runId)).terminal,
      "the auto-approved run",
    );
    await dispatchV1(
      v1Request("POST", `/runs/${waiting}/cancel`, { token }),
      testV1Deps(app, background),
    );
    await background.settle();
    expect(sentOf("approval.requested")).toHaveLength(1);
  });

  it("retries a failing endpoint with backoff, the same id and a fresh signature, then gives up", async () => {
    const { session, token } = await workspaceWithToken(app);
    const created = await addEndpoint(session, "https://hooks.example.com/flaky", [
      "run.completed",
    ]);
    const scope = { workspaceId: session.workspaceId, userId: session.userId };
    hooks.respond = () => ({
      kind: "response",
      status: 503,
      excerpt: "upstream down",
      retryAfterMs: null,
    });
    await startRun(token, XRAY);
    await until(() => hooks.sent.length === 1, "the first attempt");
    await background.settle();
    let [delivery] = (await overview(session)).deliveries;
    expect(delivery).toMatchObject({
      status: "pending",
      attempts: 1,
      lastStatusCode: 503,
      lastError: "http_error",
      lastResponseExcerpt: "upstream down",
    });
    expect(Date.parse(delivery?.nextAttemptAt ?? "") - hooks.clock.now.getTime()).toBe(
      WEBHOOK_RETRY_DELAYS_MS[0],
    );

    expect(await flushDueDeliveries(app, scope)).toMatchObject({ claimed: 0 });
    const deliveryId = delivery?.id ?? "";
    for (let attempt = 2; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt += 1) {
      const flushed = await flushDueDeliveries(app, scope, { deliveryId });
      expect(flushed.claimed, `attempt ${attempt}`).toBe(1);
      [delivery] = (await overview(session)).deliveries;
      expect(delivery?.attempts).toBe(attempt);
      if (attempt < WEBHOOK_MAX_ATTEMPTS) {
        expect(flushed.retrying).toBe(1);
        expect(delivery?.status).toBe("pending");
        expect(Date.parse(delivery?.nextAttemptAt ?? "") - hooks.clock.now.getTime()).toBe(
          WEBHOOK_RETRY_DELAYS_MS[attempt - 1],
        );
      } else {
        expect(flushed.failed).toBe(1);
        expect(delivery).toMatchObject({ status: "failed", nextAttemptAt: null });
      }
    }
    expect(hooks.sent).toHaveLength(WEBHOOK_MAX_ATTEMPTS);
    const ids = new Set(hooks.sent.map((request) => request.headers[WEBHOOK_HEADERS.delivery]));
    expect(ids.size).toBe(1);
    expect(new Set(hooks.sent.map((request) => request.body)).size).toBe(1);
    for (const request of hooks.sent) await verified(request, created.secret);
    expect(await flushDueDeliveries(app, scope)).toMatchObject({ claimed: 0 });
  });

  it("does not send a retry before it is due", async () => {
    const { session, token } = await workspaceWithToken(app);
    await addEndpoint(session, "https://hooks.example.com/early", ["run.completed"]);
    hooks.respond = () => ({ kind: "timeout" });
    await startRun(token, XRAY);
    await until(() => hooks.sent.length === 1, "the first attempt");
    await background.settle();
    const [delivery] = (await overview(session)).deliveries;
    expect(delivery).toMatchObject({ status: "pending", attempts: 1, lastError: "timeout" });
    expect(Date.parse(delivery?.nextAttemptAt ?? "")).toBeGreaterThan(Date.now() + 50_000);
    const scope = { workspaceId: session.workspaceId, userId: session.userId };
    expect(await flushDueDeliveries(app, scope)).toMatchObject({ claimed: 0 });
    expect(hooks.sent).toHaveLength(1);
  });

  it("records a redirect as a failure instead of following it, and a blocked host as blocked", async () => {
    const { session, token } = await workspaceWithToken(app);
    await addEndpoint(session, "https://hooks.example.com/moved", ["run.completed"]);
    hooks.respond = () => ({ kind: "response", status: 302, excerpt: "", retryAfterMs: null });
    await startRun(token, XRAY);
    await until(() => hooks.sent.length === 1, "the attempt");
    await background.settle();
    let [delivery] = (await overview(session)).deliveries;
    expect(delivery).toMatchObject({
      status: "pending",
      lastStatusCode: 302,
      lastError: "redirect",
    });
    hooks.respond = () => ({ kind: "blocked", problem: "private_address" });
    await flushDueDeliveries(
      app,
      { workspaceId: session.workspaceId, userId: session.userId },
      { deliveryId: delivery?.id ?? "" },
    );
    [delivery] = (await overview(session)).deliveries;
    expect(delivery).toMatchObject({ attempts: 2, lastStatusCode: null, lastError: "blocked" });
  });

  it("honours Retry-After from the receiver", async () => {
    const { session, token } = await workspaceWithToken(app);
    await addEndpoint(session, "https://hooks.example.com/busy", ["run.completed"]);
    hooks.respond = () => ({ kind: "response", status: 429, excerpt: "", retryAfterMs: 900_000 });
    await startRun(token, XRAY);
    await until(() => hooks.sent.length === 1, "the attempt");
    await background.settle();
    const [delivery] = (await overview(session)).deliveries;
    expect(Date.parse(delivery?.nextAttemptAt ?? "") - hooks.clock.now.getTime()).toBe(900_000);
  });

  it("never lets a failing webhook fail the run", async () => {
    const { session, token } = await workspaceWithToken(app);
    await addEndpoint(session, "https://hooks.example.com/broken", ALL_EVENTS);
    hooks.respond = () => {
      throw new Error("transport exploded");
    };
    const runId = await startRun(token, XRAY);
    await until(async () => (await runStatus(token, runId)).terminal, "the run");
    await background.settle();
    expect((await runStatus(token, runId)).status).toBe("completed");
    const [delivery] = (await overview(session)).deliveries;
    expect(delivery).toMatchObject({ status: "pending", attempts: 1, lastError: "network" });
  });

  it("retries due deliveries on later API traffic of the workspace, throttled", async () => {
    const { session, token } = await workspaceWithToken(app);
    await addEndpoint(session, "https://hooks.example.com/later", ["run.completed"]);
    failOnceThenBecomeDue({ kind: "network" });
    await startRun(token, XRAY);
    await until(() => hooks.sent.length === 1, "the first attempt");
    await background.settle();
    await untilDue(session);
    hooks.clock.now = new Date();
    hooks.respond = () => ({ kind: "response", status: 204, excerpt: "", retryAfterMs: null });
    resetFlushThrottle();
    const list = () =>
      dispatchV1(v1Request("GET", "/runs", { token }), testV1Deps(app, background));
    expect((await list()).status).toBe(200);
    await background.settle();
    expect(hooks.sent).toHaveLength(2);
    expect((await overview(session)).deliveries[0]).toMatchObject({
      status: "delivered",
      attempts: 2,
      lastStatusCode: 204,
    });
    const scope = { workspaceId: session.workspaceId, userId: session.userId };
    resetFlushThrottle();
    expect(flushSoon(app, scope)).toBe(true);
    expect(flushSoon(app, scope)).toBe(false);
    hooks.clock.now = new Date(hooks.clock.now.getTime() + 31_000);
    expect(flushSoon(app, scope)).toBe(true);
  });

  it("records encryption_key_missing when the key disappears after registration", async () => {
    const { session, token } = await workspaceWithToken(app);
    await addEndpoint(session, "https://hooks.example.com/nokey", ["run.completed"]);
    const keyless = createTestWebhooks(background, { encryption: false });
    keyless.clock.now = new Date();
    configureWebhooks(keyless.runtime);
    const runId = await startRun(token, XRAY);
    await until(async () => (await runStatus(token, runId)).terminal, "the run");
    await background.settle();
    expect(keyless.sent).toEqual([]);
    const [delivery] = (await overview(session)).deliveries;
    expect(delivery).toMatchObject({ status: "pending", lastError: "encryption_key_missing" });
  });
});

describe("webhook secret rotation, tests and deletion", { timeout: 40_000 }, () => {
  it("rotates the secret: the next delivery verifies with the new one only", async () => {
    const { session, token } = await workspaceWithToken(app);
    const created = await addEndpoint(session, "https://hooks.example.com/rotate", [
      "run.completed",
    ]);
    const id = created.endpoint.id;
    const response = await handleRotateWebhookSecret(
      settingsRequest("POST", `/${id}/rotate`, { session }),
      id,
      settingsDeps(),
    );
    expect(response.status).toBe(200);
    const rotated = CreatedSchema.parse(await response.json());
    expect(rotated.secret).not.toBe(created.secret);
    expect(rotated.endpoint.secretRotatedAt).not.toBeNull();
    await startRun(token, XRAY);
    await until(() => hooks.sent.length === 1, "the delivery");
    const [request] = hooks.sent;
    if (request === undefined) throw new Error("no delivery");
    await verified(request, rotated.secret);
    await expect(verified(request, created.secret)).rejects.toMatchObject({
      reason: "signature_mismatch",
    });
    await background.settle();
  });

  it("sends a signed test delivery once and reports its outcome", async () => {
    const { session } = await workspaceWithToken(app);
    const created = await addEndpoint(session, "https://hooks.example.com/test", ["run.failed"]);
    const id = created.endpoint.id;
    const send = () =>
      handleTestWebhookEndpoint(
        settingsRequest("POST", `/${id}/test`, { session }),
        id,
        settingsDeps(),
      );
    const ok = await send();
    expect(ok.status).toBe(200);
    const delivered = z.object({ delivery: DeliverySchema }).parse(await ok.json()).delivery;
    expect(delivered).toMatchObject({
      eventType: "webhook.test",
      status: "delivered",
      attempts: 1,
      runId: null,
    });
    const [request] = hooks.sent;
    if (request === undefined) throw new Error("no delivery");
    const event = await verified(request, created.secret);
    expect(event).toMatchObject({ type: "webhook.test", id: delivered.id });

    hooks.respond = () => ({ kind: "response", status: 500, excerpt: "boom", retryAfterMs: null });
    const failed = z
      .object({ delivery: DeliverySchema })
      .parse(await (await send()).json()).delivery;
    expect(failed).toMatchObject({
      status: "failed",
      attempts: 1,
      lastStatusCode: 500,
      lastError: "http_error",
      nextAttemptAt: null,
    });
  });

  it("rate limits test deliveries per workspace", async () => {
    const { session } = await workspaceWithToken(app);
    const created = await addEndpoint(session, "https://hooks.example.com/limited", ["run.failed"]);
    const id = created.endpoint.id;
    const deps = settingsDeps({ testLimiter: createRateLimiter({ limit: 1, windowMs: 60_000 }) });
    const send = () =>
      handleTestWebhookEndpoint(settingsRequest("POST", `/${id}/test`, { session }), id, deps);
    expect((await send()).status).toBe(200);
    const refused = await send();
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(hooks.sent).toHaveLength(1);
  });

  it("deletes an endpoint with its deliveries and stops notifying it", async () => {
    const { session, token } = await workspaceWithToken(app);
    const created = await addEndpoint(session, "https://hooks.example.com/gone", ["run.completed"]);
    const id = created.endpoint.id;
    await startRun(token, XRAY);
    await until(() => hooks.sent.length === 1, "the delivery");
    await background.settle();
    const response = await handleDeleteWebhookEndpoint(
      settingsRequest("DELETE", `/${id}`, { session }),
      id,
      settingsDeps(),
    );
    expect(response.status).toBe(200);
    expect(await overview(session)).toMatchObject({ endpoints: [], deliveries: [] });
    const again = await handleDeleteWebhookEndpoint(
      settingsRequest("DELETE", `/${id}`, { session }),
      id,
      settingsDeps(),
    );
    expect(again.status).toBe(404);
    const runId = await startRun(token, XRAY);
    await until(async () => (await runStatus(token, runId)).terminal, "the next run");
    await background.settle();
    expect(hooks.sent).toHaveLength(1);
  });
});
