import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type AppDatabase, createPgliteAppDatabase } from "../db";
import { createRateLimiter, SESSION_COOKIE, signSession } from "../session";
import {
  createBackground,
  createTestWebhooks,
  PUBLIC_TEST_ADDRESS,
  redteamCases,
  TEST_ORIGIN,
  TEST_SESSION_SECRET,
  testApiDeps,
  workspaceWithToken,
} from "../v1/testing";
import { configureWebhooks } from "./runtime";
import { handleAddWebhookEndpoint } from "./settings-api";
import { createWebhookTransport } from "./transport";

const cases = redteamCases("webhook-delivery");
type DeliveryCase = (typeof cases)[number];

let app: AppDatabase;
const background = createBackground();

beforeAll(async () => {
  app = await createPgliteAppDatabase();
});

afterAll(async () => {
  await background.stop();
  configureWebhooks(null);
  await app.close();
});

function resolver(table: Record<string, string[]> | undefined) {
  return (host: string) => Promise.resolve(table?.[host] ?? [PUBLIC_TEST_ADDRESS]);
}

function network(routes: NonNullable<DeliveryCase["payload"]["network"]>["routes"]) {
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requested.push(new URL(href).hostname);
    const route = routes?.[href];
    const response = new Response(route?.status === 302 ? null : (route?.body ?? "ok"), {
      status: route?.status ?? 200,
      headers: route?.headers ?? {},
    });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location !== null) {
      if (init?.redirect === "manual") return response;
      return fetchImpl(new URL(location, href).href, init);
    }
    return response;
  };
  return { requested, fetchImpl };
}

describe("red-team webhook delivery cases against the shipped transport", () => {
  it("covers the wh- delivery cases of the dataset", () => {
    expect(cases.map((attack) => attack.id)).toEqual(["wh-001", "wh-002", "wh-003", "wh-004"]);
  });

  it.each(cases)("$id: $description", async ({ payload }) => {
    const { session } = await workspaceWithToken(app);
    const hooks = createTestWebhooks(background);
    hooks.runtime.resolveDns = resolver(payload.network?.dns);
    configureWebhooks(hooks.runtime);
    const registration = await handleAddWebhookEndpoint(
      new Request(`${TEST_ORIGIN}/settings/webhooks/endpoints`, {
        method: "POST",
        headers: {
          host: "delegate.example",
          origin: TEST_ORIGIN,
          cookie: `${SESSION_COOKIE}=${signSession(session, TEST_SESSION_SECRET)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ url: payload.url, events: ["run.completed"] }),
      }),
      {
        api: testApiDeps(app, background),
        testLimiter: createRateLimiter({ limit: 10, windowMs: 60_000 }),
      },
    );
    const registered = registration.status === 201;
    if (!registered) expect(registration.status).toBe(400);

    const wire = network(payload.network?.routes);
    const send = createWebhookTransport({
      fetchImpl: wire.fetchImpl,
      resolveDns: resolver({ ...payload.network?.dns, ...payload.dnsAtDelivery }),
    });
    const outcome = await send({
      url: payload.url,
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    for (const host of payload.forbiddenHosts) expect(wire.requested).not.toContain(host);
    const delivered = outcome.kind === "response" && outcome.status >= 200 && outcome.status < 300;
    expect(delivered).toBe(false);
    if (!registered) expect(outcome.kind).toBe("blocked");
  });

  it("would notice a transport that follows redirects", async () => {
    const redirecting = cases.find((attack) => attack.id === "wh-003");
    if (redirecting === undefined) throw new Error("wh-003 is missing");
    const wire = network(redirecting.payload.network?.routes);
    await wire.fetchImpl(redirecting.payload.url, { method: "POST" });
    expect(wire.requested).toContain(redirecting.payload.forbiddenHosts[0]);
  });
});
