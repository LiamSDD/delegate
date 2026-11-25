import { auditLog, mcpConnectors, withTenant } from "@delegate/db";
import { createMemoryAssistantStore } from "@delegate/runtime/server";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { authenticateBearer, createApiToken } from "../api-tokens";
import { listAssistants } from "../assistants";
import { listActiveRuns } from "../control/active-runs";
import {
  jsonPost,
  newGuest,
  newRun,
  ORIGIN,
  type TestDeps,
  type TestGuest,
  testDeps,
} from "../control/testing";
import { type AppDatabase, createPgliteAppDatabase } from "../db";
import { appendEvent, getRunRecord, listRuns, readAllEvents, type RunContext } from "../runs";
import { readGuest, SESSION_COOKIE } from "../session";
import { readRunsPaused, setRunsPaused, updateAutomation } from "../workspace-settings";
import {
  DELETE_CONFIRMATION,
  type DeleteDeps,
  evictAssistants,
  handleDeleteData,
  isConfirmed,
} from "./delete";
import { dataInventory, EMPTY_INVENTORY, isEmptyInventory } from "./inventory";

let app: AppDatabase;

beforeAll(async () => {
  app = await createPgliteAppDatabase();
});

afterAll(async () => {
  await app.close();
});

const confirm = { confirm: DELETE_CONFIRMATION };

interface Seeded {
  guest: TestGuest;
  finished: RunContext;
  active: RunContext;
  assistantId: string;
  token: string;
}

async function seed(label: string): Promise<Seeded> {
  const guest = await newGuest(app);
  const finished = await newRun(app, guest, { missionId: "build-agent" });
  const assistantId = crypto.randomUUID();
  await appendEvent(app, finished, {
    type: "artifact.created",
    payload: {
      artifactId: crypto.randomUUID(),
      kind: "assistant",
      title: `Assistant ${label}`,
      version: 1,
      content: { id: assistantId, name: `Assistant ${label}` },
    },
  });
  await appendEvent(app, finished, { type: "run.completed", payload: { summary: "built" } });
  const active = await newRun(app, guest);
  const { token } = await createApiToken(app, guest.session, `token ${label}`);
  await withTenant(app.db, guest.session.userId, (tx) =>
    tx.insert(mcpConnectors).values({
      workspaceId: guest.session.workspaceId,
      name: "tickets",
      url: `https://mcp.${label}.example/mcp`,
    }),
  );
  await updateAutomation(app, guest.session, { autoApprovePlans: true });
  return { guest, finished, active, assistantId, token };
}

function deps(overrides: Partial<DeleteDeps> = {}): DeleteDeps & Pick<TestDeps, "tasks"> {
  return { ...testDeps(app), assistantStore: () => createMemoryAssistantStore(), ...overrides };
}

function bearer(token: string) {
  return new Request(`${ORIGIN}/api/runs`, { headers: { authorization: `Bearer ${token}` } });
}

describe("the typed confirmation", () => {
  it("accepts the phrase whatever the case or spacing, and nothing else", () => {
    expect(isConfirmed("delete my data")).toBe(true);
    expect(isConfirmed("  Delete   my DATA ")).toBe(true);
    expect(isConfirmed("delete my dat")).toBe(false);
    expect(isConfirmed("delete")).toBe(false);
    expect(isConfirmed("")).toBe(false);
  });
});

describe("the data inventory", () => {
  it("counts what the workspace holds and nothing of another", async () => {
    const empty = await newGuest(app);
    expect(await dataInventory(app, empty.session)).toEqual(EMPTY_INVENTORY);
    expect(isEmptyInventory(EMPTY_INVENTORY)).toBe(true);
    const a = await seed("inventory");
    await seed("inventory-other");
    const inventory = await dataInventory(app, a.guest.session);
    expect(inventory).toEqual({
      runs: 2,
      events: 4,
      artifacts: 1,
      assistants: 1,
      connectors: 1,
      githubInstallations: 0,
      apiTokens: 1,
      settings: 1,
    });
    expect(isEmptyInventory(inventory)).toBe(false);
  });
});

describe("POST /settings/data/delete", () => {
  it("removes this workspace's data, signs the visitor out and leaves every other workspace alone", async () => {
    const a = await seed("a");
    const b = await seed("b");
    const store = createMemoryAssistantStore();
    for (const seeded of [a, b])
      await store.save({
        id: seeded.assistantId,
        runId: seeded.finished.runId,
        name: "Assistant",
        collection: `assistant-${seeded.assistantId}`,
        config: {},
      });
    const d = deps({ assistantStore: () => store });
    const executing = d.registry.register(a.active.runId).signal;
    const otherBefore = await dataInventory(app, b.guest.session);
    const otherEvents = await readAllEvents(app, b.guest.session.userId, b.finished.runId);

    const response = await handleDeleteData(
      jsonPost("/settings/data/delete", a.guest.cookie, confirm),
      d,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { deleted: boolean; counts: Record<string, number> };
    expect(body.deleted).toBe(true);
    expect(body.counts).toMatchObject({
      runs: 2,
      events: 5,
      artifacts: 1,
      connectors: 1,
      apiTokens: 1,
      settings: 1,
    });

    const cookies = response.headers.getSetCookie();
    expect(cookies).toContain(`${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
    expect(cookies.filter((cookie) => cookie.includes("Max-Age=0"))).toHaveLength(3);
    expect(response.headers.get("cache-control")).toBe("no-store");

    expect(executing.aborted).toBe(true);
    expect(await dataInventory(app, a.guest.session)).toEqual(EMPTY_INVENTORY);
    expect(await listRuns(app, a.guest.session)).toEqual([]);
    expect(await listAssistants(app, a.guest.session)).toEqual([]);
    expect((await listActiveRuns(app, a.guest.session)).runs).toEqual([]);
    expect(await getRunRecord(app, a.guest.session.userId, a.finished.runId)).toBeNull();
    expect(await readRunsPaused(app, a.guest.session)).toBeNull();
    expect(await authenticateBearer(app, bearer(a.token))).toBeNull();
    expect(await store.get(a.assistantId)).toBeNull();

    const receipts = await withTenant(app.db, a.guest.session.userId, (tx) =>
      tx
        .select({ action: auditLog.action, actorId: auditLog.actorId, details: auditLog.details })
        .from(auditLog)
        .where(eq(auditLog.workspaceId, a.guest.session.workspaceId)),
    );
    expect(receipts).toEqual([
      {
        action: "workspace.data_deleted",
        actorId: a.guest.session.userId,
        details: { counts: body.counts },
      },
    ]);

    expect(await dataInventory(app, b.guest.session)).toEqual(otherBefore);
    expect(await readAllEvents(app, b.guest.session.userId, b.finished.runId)).toEqual(otherEvents);
    expect((await getRunRecord(app, b.guest.session.userId, b.active.runId))?.status).toBe(
      "planning",
    );
    expect((await authenticateBearer(app, bearer(b.token)))?.workspaceId).toBe(
      b.guest.session.workspaceId,
    );
    expect(await store.get(b.assistantId)).not.toBeNull();
    expect(
      await readGuest(app, b.guest.cookie.slice(SESSION_COOKIE.length + 1), "s".repeat(32)),
    ).toEqual(b.guest.session);
  });

  it("deletes a paused workspace too and can be repeated safely", async () => {
    const a = await seed("paused");
    await setRunsPaused(app, a.guest.session, true);
    const first = await handleDeleteData(
      jsonPost("/settings/data/delete", a.guest.cookie, confirm),
      deps(),
    );
    expect(first.status).toBe(200);
    const again = await handleDeleteData(
      jsonPost("/settings/data/delete", a.guest.cookie, confirm),
      deps(),
    );
    expect(again.status).toBe(200);
    const body = (await again.json()) as { counts: Record<string, number> };
    expect(Object.values(body.counts).every((value) => value === 0)).toBe(true);
    expect(await dataInventory(app, a.guest.session)).toEqual(EMPTY_INVENTORY);
  });

  it("needs the typed phrase, the same origin and a browser session, and deletes nothing otherwise", async () => {
    const a = await seed("guarded");
    const before = await dataInventory(app, a.guest.session);
    const d = deps();
    const refused = [
      [jsonPost("/settings/data/delete", a.guest.cookie, {}), 400],
      [jsonPost("/settings/data/delete", a.guest.cookie, { confirm: "yes" }), 400],
      [jsonPost("/settings/data/delete", a.guest.cookie, { confirm: "delete" }), 400],
      [
        jsonPost("/settings/data/delete", a.guest.cookie, confirm, {
          origin: "https://evil.example",
        }),
        403,
      ],
      [
        jsonPost("/settings/data/delete", null, confirm, { authorization: `Bearer ${a.token}` }),
        403,
      ],
      [jsonPost("/settings/data/delete", null, confirm), 404],
      [jsonPost("/settings/data/delete", "delegate_session=forged.value", confirm), 404],
    ] as const;
    for (const [request, status] of refused)
      expect((await handleDeleteData(request, d)).status).toBe(status);
    expect(await dataInventory(app, a.guest.session)).toEqual(before);
    expect((await getRunRecord(app, a.guest.session.userId, a.active.runId))?.status).toBe(
      "planning",
    );
  });

  it("cannot be aimed at another workspace: the request names none and extra fields are refused", async () => {
    const a = await seed("target");
    const stranger = await seed("stranger");
    const before = await dataInventory(app, a.guest.session);
    const aimed = await handleDeleteData(
      jsonPost("/settings/data/delete", stranger.guest.cookie, {
        ...confirm,
        workspaceId: a.guest.session.workspaceId,
      }),
      deps(),
    );
    expect(aimed.status).toBe(400);
    expect(await dataInventory(app, stranger.guest.session)).not.toEqual(EMPTY_INVENTORY);

    const own = await handleDeleteData(
      jsonPost("/settings/data/delete", stranger.guest.cookie, confirm),
      deps(),
    );
    expect(own.status).toBe(200);
    expect(await dataInventory(app, stranger.guest.session)).toEqual(EMPTY_INVENTORY);
    expect(await dataInventory(app, a.guest.session)).toEqual(before);
  });
});

describe("evicting assistants from this instance's memory", () => {
  it("drops only the listed assistants and tolerates a store without records", async () => {
    const store = createMemoryAssistantStore();
    for (const id of ["one", "two"])
      await store.save({ id, runId: "run", name: id, collection: id, config: {} });
    expect(evictAssistants(["one", "missing"], store)).toBe(1);
    expect(await store.get("one")).toBeNull();
    expect(await store.get("two")).not.toBeNull();
    expect(evictAssistants(["two"], { get: () => Promise.resolve(null) })).toBe(0);
    expect(evictAssistants(["two"], null)).toBe(0);
  });
});
