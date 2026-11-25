import { randomBytes } from "node:crypto";

import { OPERATIONS, type OperationId } from "@delegate/sdk/contract";

import type { AnswerEvent } from "@/lib/m3-contract";

import type { ApiDeps } from "../api";
import { createApiToken } from "../api-tokens";
import type { AssistantStores } from "../assistants";
import type { AppDatabase } from "../db";
import { createFakeRunner } from "../fake-runner";
import { createRunRegistry, type RunRegistry } from "../run-registry";
import { createSecretBox } from "../secrets";
import { createRateLimiter, resolveGuest } from "../session";
import type { WebhookRuntime } from "../webhooks/runtime";
import type { WebhookRequest, WebhookSendOutcome } from "../webhooks/transport";
import type { V1Deps } from "./handlers";
import { createRequestLimiter } from "./rate-limit";
import { handleOpenApi, handleUnknownRoute, handleV1 } from "./router";

export const TEST_ORIGIN = "https://delegate.example";
export const TEST_SESSION_SECRET = "s".repeat(32);
export const PUBLIC_TEST_ADDRESS = "93.184.215.14";

export interface TestBackground {
  tasks: Promise<void>[];
  registry: RunRegistry;
  settle(): Promise<void>;
  stop(graceMs?: number): Promise<void>;
}

export function createBackground(): TestBackground {
  const tasks: Promise<void>[] = [];
  const inner = createRunRegistry();
  const open = new Set<string>();
  const registry: RunRegistry = {
    register(runId) {
      open.add(runId);
      return inner.register(runId);
    },
    abort: (runId, reason) => inner.abort(runId, reason),
    unregister(runId) {
      open.delete(runId);
      inner.unregister(runId);
    },
    has: (runId) => inner.has(runId),
  };
  const settle = async () => {
    for (let seen = -1; seen !== tasks.length;) {
      seen = tasks.length;
      await Promise.allSettled(tasks);
    }
  };
  return {
    tasks,
    registry,
    settle,
    async stop(graceMs = 5_000) {
      for (const runId of open) inner.abort(runId, "test finished");
      await Promise.race([settle(), new Promise((resolve) => setTimeout(resolve, graceMs))]);
    },
  };
}

export function testApiDeps(
  app: AppDatabase,
  background: TestBackground,
  overrides: Partial<ApiDeps> = {},
): ApiDeps {
  return {
    app: () => Promise.resolve(app),
    secret: () => TEST_SESSION_SECRET,
    guestLimiter: createRateLimiter({ limit: 500, windowMs: 3_600_000 }),
    ipLimiter: createRateLimiter({ limit: 500, windowMs: 3_600_000 }),
    registry: background.registry,
    runner: () => ({ execution: "simulated", run: createFakeRunner({ delayMs: 0 }) }),
    schedule: (task) => {
      background.tasks.push(task());
    },
    production: false,
    stream: { pollMs: 5, heartbeatMs: 60_000, idleHookMs: 60_000 },
    ...overrides,
  };
}

export function testV1Deps(
  app: AppDatabase,
  background: TestBackground,
  overrides: { api?: Partial<ApiDeps>; limiter?: V1Deps["limiter"]; chat?: V1Deps["chat"] } = {},
): V1Deps {
  const stores: AssistantStores = {
    knowledge: {} as AssistantStores["knowledge"],
    assistants: {
      get: () => Promise.resolve({}),
    } as unknown as AssistantStores["assistants"],
  };
  return {
    api: testApiDeps(app, background, overrides.api),
    limiter: overrides.limiter ?? createRequestLimiter({ limit: 10_000, windowMs: 3_600_000 }),
    chat: overrides.chat ?? {
      limiter: createRateLimiter({ limit: 100, windowMs: 3_600_000 }),
      stores: () => stores,
      answer: async function* (options): AsyncGenerator<AnswerEvent> {
        await Promise.resolve();
        yield { type: "delta", text: `Answer to ${options.question} [1].` };
        yield { type: "citation", index: 1, chunkId: "k1", url: "https://acme.example/a" };
        yield {
          type: "done",
          answer: `Answer to ${options.question} [1].`,
          citations: [{ index: 1, chunkId: "k1", url: "https://acme.example/a" }],
          grounded: true,
          refused: false,
          usage: { inputTokens: 10, outputTokens: 5 },
          retrieval: { mode: "full-text", candidates: 1, used: 1, reranked: false },
          durationMs: 3,
        };
      },
    },
  };
}

export async function workspaceWithToken(app: AppDatabase, name = "ci") {
  const { session } = await resolveGuest(app, undefined, TEST_SESSION_SECRET);
  const { token, listing } = await createApiToken(app, session, name);
  return { session, token, tokenId: listing.id };
}

interface Matched {
  id: OperationId;
  params: Record<string, string>;
}

export function matchOperation(method: string, pathname: string): Matched | null {
  const relative = pathname.replace(/^\/api\/v1/, "");
  for (const [id, spec] of Object.entries(OPERATIONS)) {
    if (spec.method !== method) continue;
    const names: string[] = [];
    const pattern = spec.path.replace(/\{(\w+)\}/g, (_match, name: string) => {
      names.push(name);
      return "([^/]+)";
    });
    const match = new RegExp(`^${pattern}$`).exec(relative);
    if (match === null) continue;
    return {
      id: id as OperationId,
      params: Object.fromEntries(
        names.map((name, index) => [name, decodeURIComponent(match[index + 1] ?? "")]),
      ),
    };
  }
  return null;
}

export interface SendOptions {
  token?: string | null;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export function v1Request(method: string, path: string, options: SendOptions = {}): Request {
  const body =
    options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  return new Request(`${TEST_ORIGIN}/api/v1${path}`, {
    method,
    headers: {
      ...(options.token === null || options.token === undefined
        ? {}
        : { authorization: `Bearer ${options.token}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      "x-forwarded-for": "203.0.113.7",
      ...options.headers,
    },
    ...(body === undefined ? {} : { body }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

export function dispatchV1(request: Request, deps: V1Deps): Promise<Response> {
  const matched = matchOperation(request.method, new URL(request.url).pathname);
  if (matched === null) return Promise.resolve(handleUnknownRoute(request));
  if (matched.id === "getOpenApi") return Promise.resolve(handleOpenApi());
  return handleV1(matched.id, request, matched.params, deps);
}

export interface RecordedWebhook extends WebhookRequest {
  at: Date;
}

export interface TestWebhooks {
  runtime: WebhookRuntime;
  sent: RecordedWebhook[];
  clock: { now: Date };
  respond: (request: WebhookRequest) => WebhookSendOutcome | Promise<WebhookSendOutcome>;
  dns: Map<string, string[]>;
  key: Buffer;
}

export function createTestWebhooks(
  background: TestBackground,
  options: { encryption?: boolean } = {},
): TestWebhooks {
  const key = randomBytes(32);
  const box = options.encryption === false ? null : createSecretBox(key);
  const state: TestWebhooks = {
    sent: [],
    clock: { now: new Date("2026-11-25T12:00:00.000Z") },
    respond: () => ({ kind: "response", status: 200, excerpt: "ok", retryAfterMs: null }),
    dns: new Map(),
    key,
    runtime: {
      schedule: (task) => {
        background.tasks.push(task());
      },
      transport: async (request) => {
        state.sent.push({ ...request, at: state.clock.now });
        return state.respond(request);
      },
      resolveDns: (host) => Promise.resolve(state.dns.get(host) ?? [PUBLIC_TEST_ADDRESS]),
      box: () => box,
      now: () => state.clock.now,
    },
  };
  return state;
}
