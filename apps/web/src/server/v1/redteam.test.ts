import { loadRedteamDataset, type RedteamCase } from "@delegate/evals";
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_REPLAYED_HEADER,
  RunListSchema,
  RunSchema,
} from "@delegate/sdk/contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type AppDatabase, createPgliteAppDatabase } from "../db";
import { configureWebhooks } from "../webhooks/runtime";
import {
  createBackground,
  createTestWebhooks,
  dispatchV1,
  type SendOptions,
  testV1Deps,
  v1Request,
  workspaceWithToken,
} from "./testing";

type TenantCase = Extract<RedteamCase, { target: "tenant" }>;
type Attack = TenantCase["payload"]["attack"];

const cases = loadRedteamDataset().filter(
  (attack): attack is TenantCase => attack.target === "tenant",
);

let app: AppDatabase;
const background = createBackground();

beforeAll(async () => {
  app = await createPgliteAppDatabase();
  configureWebhooks(createTestWebhooks(background).runtime);
});

afterAll(async () => {
  await background.stop();
  configureWebhooks(null);
  await app.close();
});

function send(method: "GET" | "POST", path: string, options: SendOptions) {
  return dispatchV1(v1Request(method, path, options), testV1Deps(app, background));
}

const AUDIT = { missionId: "automation-audit", input: { url: "victim.example" } };

async function victimRun(token: string, headers: Record<string, string> = {}) {
  const response = await send("POST", "/runs", { token, body: AUDIT, headers });
  expect(response.status).toBe(201);
  const run = RunSchema.parse(await response.json());
  const deadline = Date.now() + 20_000;
  for (;;) {
    const current = RunSchema.parse(await (await send("GET", `/runs/${run.id}`, { token })).json());
    if (current.pendingPlan !== null) return current;
    if (Date.now() > deadline) throw new Error("the victim's run never proposed a plan");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

const ATTACKS: Record<Attack, () => Promise<void>> = {
  "read-run": async () => {
    const victim = await workspaceWithToken(app);
    const attacker = await workspaceWithToken(app);
    const run = await victimRun(victim.token);
    for (const [path, headers] of [
      [`/runs/${run.id}`, {}],
      [`/runs/${run.id}/events`, {}],
      [`/runs/${run.id}/events`, { accept: "text/event-stream" }],
      [`/runs/${run.id}/artifacts`, {}],
      [`/runs/${run.id}/artifacts/audit`, {}],
    ] as const) {
      const response = await send("GET", path, { token: attacker.token, headers });
      expect(response.status, path).toBe(404);
      expect(await response.text()).not.toContain("victim.example");
    }
    const listed = RunListSchema.parse(
      await (await send("GET", "/runs?limit=100", { token: attacker.token })).json(),
    );
    expect(listed.data).toEqual([]);
  },
  "write-run": async () => {
    const victim = await workspaceWithToken(app);
    const attacker = await workspaceWithToken(app);
    const run = await victimRun(victim.token);
    for (const path of [
      `/runs/${run.id}/cancel`,
      `/runs/${run.id}/plan/approve`,
      `/runs/${run.id}/plan/reject`,
    ]) {
      const response = await send("POST", path, { token: attacker.token });
      expect(response.status, path).toBe(404);
    }
    const after = RunSchema.parse(
      await (await send("GET", `/runs/${run.id}`, { token: victim.token })).json(),
    );
    expect(after.status).toBe("awaiting_plan_approval");
    expect(after.error).toBeNull();
  },
  "replay-idempotency-key": async () => {
    const victim = await workspaceWithToken(app);
    const attacker = await workspaceWithToken(app);
    const headers = { [IDEMPOTENCY_KEY_HEADER]: "deploy-2026-11-25" };
    const first = await victimRun(victim.token, headers);
    const replay = await send("POST", "/runs", { token: attacker.token, body: AUDIT, headers });
    expect(replay.status).toBe(201);
    expect(replay.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBeNull();
    const answered = RunSchema.parse(await replay.json());
    expect(answered.id).not.toBe(first.id);
    const peek = await send("GET", `/runs/${first.id}`, { token: attacker.token });
    expect(peek.status).toBe(404);
    const own = await send("POST", "/runs", { token: victim.token, body: AUDIT, headers });
    expect(own.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBe("true");
    expect(RunSchema.parse(await own.json()).id).toBe(first.id);
  },
};

describe("red-team api cases through the v1 handlers", { timeout: 40_000 }, () => {
  it("covers the api- cases of the dataset", () => {
    expect(cases.map((attack) => attack.id)).toEqual(["api-001", "api-002", "api-003"]);
    expect(new Set(cases.map((attack) => attack.payload.attack)).size).toBe(cases.length);
  });

  it.each(cases)("$id: $description", async ({ payload }) => {
    await ATTACKS[payload.attack]();
  });
});
