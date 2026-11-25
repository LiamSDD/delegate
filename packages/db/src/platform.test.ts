import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createGuestWorkspace, type TenantTx, withTenant } from "./client";
import {
  beginIdempotentRequest,
  claimWebhookDeliveries,
  completeIdempotentRequest,
  enqueueWebhookDeliveries,
  enqueueWebhookTest,
  releaseIdempotentRequest,
  settleWebhookDelivery,
} from "./platform";
import {
  idempotencyKeys,
  runs,
  WEBHOOK_EVENT_TYPES,
  webhookDeliveries,
  webhookEndpoints,
} from "./schema";
import type { MemberRoleName } from "./schema/rls";
import { seedMember, seedUser } from "./testing/fixtures";
import { asAppLogin, createTestDb, expectDatabaseError, type TestDb } from "./testing/pglite";

let harness: Awaited<ReturnType<typeof createTestDb>>;
let db: TestDb;

beforeAll(async () => {
  harness = await createTestDb();
  db = harness.db;
});

afterAll(async () => {
  await harness.client.close();
});

interface Tenant {
  userId: string;
  workspaceId: string;
}

const guest = (): Promise<Tenant> => asAppLogin(db, () => createGuestWorkspace(db));

function as<T>(userId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return asAppLogin(db, () => withTenant(db, userId, fn));
}

function refused(
  userId: string,
  fn: (tx: TenantTx) => Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  return asAppLogin(db, () => expectDatabaseError(withTenant(db, userId, fn), pattern));
}

async function colleague(workspaceId: string, role: MemberRoleName): Promise<Tenant> {
  const user = await seedUser(db, `${role}-${crypto.randomUUID()}`);
  await seedMember(db, workspaceId, user.id, role);
  return { userId: user.id, workspaceId };
}

async function startRun(tenant: Tenant): Promise<string> {
  const [run] = await as(tenant.userId, (tx) =>
    tx
      .insert(runs)
      .values({ workspaceId: tenant.workspaceId, mission: "company-xray", input: {}, budget: {} })
      .returning({ id: runs.id }),
  );
  if (run === undefined) throw new Error("run insert returned no row");
  return run.id;
}

const SEALED = "v1.iv.tag.ciphertext";

async function addEndpoint(
  tenant: Tenant,
  options: { url?: string; events?: string[] } = {},
): Promise<string> {
  const [row] = await as(tenant.userId, (tx) =>
    tx
      .insert(webhookEndpoints)
      .values({
        workspaceId: tenant.workspaceId,
        url: options.url ?? `https://hooks.example/${crypto.randomUUID()}`,
        origin: "https://delegate.example",
        events: options.events ?? [...WEBHOOK_EVENT_TYPES],
        secretCiphertext: SEALED,
      })
      .returning({ id: webhookEndpoints.id }),
  );
  if (row === undefined) throw new Error("endpoint insert returned no row");
  return row.id;
}

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function scope(tenant: Tenant, key = `key-${crypto.randomUUID()}`, requestHash = HASH_A) {
  return { workspaceId: tenant.workspaceId, key, requestHash };
}

const begin = (tenant: Tenant, request: ReturnType<typeof scope>, lockSeconds = 120) =>
  as(tenant.userId, (tx) =>
    beginIdempotentRequest(tx, { ...request, lockSeconds, ttlSeconds: 86_400 }),
  );

describe("idempotency keys", () => {
  it("starts once, then replays the stored response for the same request", async () => {
    const owner = await guest();
    const request = scope(owner);
    expect(await begin(owner, request)).toEqual({ outcome: "started" });
    expect(
      await as(owner.userId, (tx) =>
        completeIdempotentRequest(tx, { ...request, status: 201, body: '{"id":"run-1"}' }),
      ),
    ).toBe(true);
    expect(await begin(owner, request)).toEqual({
      outcome: "replay",
      status: 201,
      body: '{"id":"run-1"}',
    });
    expect(await begin(owner, request)).toMatchObject({ outcome: "replay" });
  });

  it("reports a key reused with a different request", async () => {
    const owner = await guest();
    const request = scope(owner);
    await begin(owner, request);
    expect(await begin(owner, { ...request, requestHash: HASH_B })).toEqual({
      outcome: "mismatch",
    });
    await as(owner.userId, (tx) =>
      completeIdempotentRequest(tx, { ...request, status: 200, body: "{}" }),
    );
    expect(await begin(owner, { ...request, requestHash: HASH_B })).toEqual({
      outcome: "mismatch",
    });
  });

  it("holds a concurrent duplicate off while the first request is in progress", async () => {
    const owner = await guest();
    const request = scope(owner);
    await begin(owner, request);
    expect(await begin(owner, request)).toEqual({ outcome: "in_progress" });
  });

  it("lets a retry take over a request whose lock expired", async () => {
    const owner = await guest();
    const request = scope(owner);
    await begin(owner, request);
    await db
      .update(idempotencyKeys)
      .set({ lockedUntil: new Date(Date.now() - 1_000) })
      .where(eq(idempotencyKeys.key, request.key));
    expect(await begin(owner, request)).toEqual({ outcome: "started" });
    expect(await begin(owner, request)).toEqual({ outcome: "in_progress" });
  });

  it("releases a failed request so the same key can run again", async () => {
    const owner = await guest();
    const request = scope(owner);
    await begin(owner, request);
    expect(await as(owner.userId, (tx) => releaseIdempotentRequest(tx, request))).toBe(true);
    expect(await as(owner.userId, (tx) => releaseIdempotentRequest(tx, request))).toBe(false);
    expect(await begin(owner, request)).toEqual({ outcome: "started" });
  });

  it("never releases or overwrites a completed response", async () => {
    const owner = await guest();
    const request = scope(owner);
    await begin(owner, request);
    await as(owner.userId, (tx) =>
      completeIdempotentRequest(tx, { ...request, status: 201, body: "first" }),
    );
    expect(await as(owner.userId, (tx) => releaseIdempotentRequest(tx, request))).toBe(false);
    expect(
      await as(owner.userId, (tx) =>
        completeIdempotentRequest(tx, { ...request, status: 200, body: "second" }),
      ),
    ).toBe(false);
    expect(await begin(owner, request)).toEqual({ outcome: "replay", status: 201, body: "first" });
  });

  it("completes only the request that holds the key", async () => {
    const owner = await guest();
    const request = scope(owner);
    await begin(owner, request);
    expect(
      await as(owner.userId, (tx) =>
        completeIdempotentRequest(tx, { ...request, requestHash: HASH_B, status: 200, body: "x" }),
      ),
    ).toBe(false);
    expect(await begin(owner, request)).toEqual({ outcome: "in_progress" });
  });

  it("forgets a key after its lifetime and purges expired rows of the workspace", async () => {
    const owner = await guest();
    const stale = scope(owner);
    const other = scope(owner);
    await begin(owner, stale);
    await as(owner.userId, (tx) =>
      completeIdempotentRequest(tx, { ...stale, status: 201, body: "old" }),
    );
    await begin(owner, other);
    await db
      .update(idempotencyKeys)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(idempotencyKeys.workspaceId, owner.workspaceId));
    expect(await begin(owner, stale)).toEqual({ outcome: "started" });
    const remaining = await db
      .select({ key: idempotencyKeys.key })
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.workspaceId, owner.workspaceId));
    expect(remaining.map((row) => row.key)).toEqual([stale.key]);
  });

  it("stores only successful responses of a bounded size", async () => {
    const owner = await guest();
    const request = scope(owner);
    await begin(owner, request);
    await refused(
      owner.userId,
      (tx) =>
        tx.execute(
          sql`select idempotency_complete(${owner.workspaceId}::uuid, ${request.key}, ${HASH_A}, 500, 'boom')`,
        ),
      /idempotency_keys_response_is_success/,
    );
    await refused(
      owner.userId,
      (tx) => completeIdempotentRequest(tx, { ...request, status: 201, body: "x".repeat(262_145) }),
      /idempotency_keys_response_size/,
    );
  });

  it("refuses keys that are not printable ASCII and out-of-range lifetimes", async () => {
    const owner = await guest();
    await expect(begin(owner, scope(owner, "has space"))).rejects.toThrow();
    await refused(
      owner.userId,
      (tx) =>
        tx.execute(
          sql`select * from idempotency_begin(${owner.workspaceId}::uuid, 'line' || chr(10) || 'break', ${HASH_A}, 120, 86400)`,
        ),
      /idempotency_keys_key_format/,
    );
    await refused(
      owner.userId,
      (tx) =>
        tx.execute(
          sql`select * from idempotency_begin(${owner.workspaceId}::uuid, 'k', ${HASH_A}, 0, 86400)`,
        ),
      /out of range/,
    );
  });

  it("keeps the same key separate in every workspace", async () => {
    const first = await guest();
    const second = await guest();
    const key = `shared-${crypto.randomUUID()}`;
    await begin(first, scope(first, key));
    await as(first.userId, (tx) =>
      completeIdempotentRequest(tx, { ...scope(first, key), status: 201, body: "first workspace" }),
    );
    expect(await begin(second, scope(second, key))).toEqual({ outcome: "started" });
    await as(second.userId, (tx) =>
      completeIdempotentRequest(tx, {
        ...scope(second, key),
        status: 201,
        body: "second workspace",
      }),
    );
    expect(await begin(first, scope(first, key))).toMatchObject({ body: "first workspace" });
    expect(await begin(second, scope(second, key))).toMatchObject({ body: "second workspace" });
  });

  it("refuses a caller who names another workspace", async () => {
    const victim = await guest();
    const attacker = await guest();
    const request = scope(victim);
    await begin(victim, request);
    await as(victim.userId, (tx) =>
      completeIdempotentRequest(tx, { ...request, status: 201, body: "secret" }),
    );
    for (const attempt of [
      (tx: TenantTx) =>
        beginIdempotentRequest(tx, { ...request, lockSeconds: 120, ttlSeconds: 86_400 }),
      (tx: TenantTx) => completeIdempotentRequest(tx, { ...request, status: 200, body: "x" }),
      (tx: TenantTx) => releaseIdempotentRequest(tx, request),
    ])
      await refused(attacker.userId, (tx) => attempt(tx), /only an operator of the workspace/);
    expect(await begin(victim, request)).toMatchObject({ outcome: "replay", body: "secret" });
  });

  it("is open to operators and closed to viewers", async () => {
    const owner = await guest();
    const operator = await colleague(owner.workspaceId, "operator");
    const viewer = await colleague(owner.workspaceId, "viewer");
    expect(await begin(operator, scope(operator))).toEqual({ outcome: "started" });
    await refused(
      viewer.userId,
      (tx) =>
        beginIdempotentRequest(tx, { ...scope(viewer), lockSeconds: 120, ttlSeconds: 86_400 }),
      /only an operator of the workspace/,
    );
  });

  it("cannot be read or written by tenant SQL, even by the workspace owner", async () => {
    const owner = await guest();
    const request = scope(owner);
    await begin(owner, request);
    await refused(owner.userId, (tx) => tx.select().from(idempotencyKeys), /permission denied/);
    await refused(
      owner.userId,
      (tx) =>
        tx.insert(idempotencyKeys).values({
          workspaceId: owner.workspaceId,
          key: "forged",
          requestHash: HASH_A,
          lockedUntil: new Date(),
          expiresAt: new Date(),
        }),
      /permission denied/,
    );
    await refused(
      owner.userId,
      (tx) => tx.update(idempotencyKeys).set({ responseBody: "forged" }),
      /permission denied/,
    );
    await refused(owner.userId, (tx) => tx.delete(idempotencyKeys), /permission denied/);
  });
});

const endpointColumns = {
  id: webhookEndpoints.id,
  url: webhookEndpoints.url,
  events: webhookEndpoints.events,
  secretRotatedAt: webhookEndpoints.secretRotatedAt,
};

describe("webhook endpoints", () => {
  it("lets an admin add, list, rotate and delete an endpoint", async () => {
    const owner = await guest();
    const id = await addEndpoint(owner, { events: ["run.completed"] });
    const listed = await as(owner.userId, (tx) =>
      tx.select(endpointColumns).from(webhookEndpoints).where(eq(webhookEndpoints.id, id)),
    );
    expect(listed).toMatchObject([{ id, events: ["run.completed"], secretRotatedAt: null }]);
    await as(owner.userId, (tx) =>
      tx
        .update(webhookEndpoints)
        .set({ secretCiphertext: "v1.new.tag.ciphertext", secretRotatedAt: new Date() })
        .where(eq(webhookEndpoints.id, id)),
    );
    const [stored] = await db
      .select({ secretCiphertext: webhookEndpoints.secretCiphertext })
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, id));
    expect(stored?.secretCiphertext).toBe("v1.new.tag.ciphertext");
    const deleted = await as(owner.userId, (tx) =>
      tx
        .delete(webhookEndpoints)
        .where(eq(webhookEndpoints.id, id))
        .returning({ id: webhookEndpoints.id }),
    );
    expect(deleted).toHaveLength(1);
  });

  it("never lets tenant SQL read the secret ciphertext", async () => {
    const owner = await guest();
    await addEndpoint(owner);
    await refused(
      owner.userId,
      (tx) => tx.select({ secret: webhookEndpoints.secretCiphertext }).from(webhookEndpoints),
      /permission denied/,
    );
    await refused(owner.userId, (tx) => tx.select().from(webhookEndpoints), /permission denied/);
  });

  it("hides endpoints from operators, viewers and other workspaces, and refuses their writes", async () => {
    const owner = await guest();
    const id = await addEndpoint(owner);
    const outsiders = [
      await colleague(owner.workspaceId, "operator"),
      await colleague(owner.workspaceId, "viewer"),
      await guest(),
    ];
    for (const outsider of outsiders) {
      expect(
        await as(outsider.userId, (tx) => tx.select(endpointColumns).from(webhookEndpoints)),
      ).toEqual([]);
      await refused(
        outsider.userId,
        (tx) =>
          tx.insert(webhookEndpoints).values({
            workspaceId: owner.workspaceId,
            url: `https://attacker.example/${crypto.randomUUID()}`,
            origin: "https://delegate.example",
            events: ["run.completed"],
            secretCiphertext: SEALED,
          }),
        /row-level security/,
      );
      expect(
        await as(outsider.userId, (tx) =>
          tx
            .update(webhookEndpoints)
            .set({ secretCiphertext: "attacker" })
            .where(eq(webhookEndpoints.id, id))
            .returning({ id: webhookEndpoints.id }),
        ),
      ).toEqual([]);
      expect(
        await as(outsider.userId, (tx) =>
          tx
            .delete(webhookEndpoints)
            .where(eq(webhookEndpoints.id, id))
            .returning({ id: webhookEndpoints.id }),
        ),
      ).toEqual([]);
    }
    const [kept] = await db
      .select({ secretCiphertext: webhookEndpoints.secretCiphertext })
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, id));
    expect(kept?.secretCiphertext).toBe(SEALED);
  });

  it("records the caller as creator and refuses a forged one", async () => {
    const owner = await guest();
    const other = await guest();
    await refused(
      owner.userId,
      (tx) =>
        tx.insert(webhookEndpoints).values({
          workspaceId: owner.workspaceId,
          createdBy: other.userId,
          url: "https://hooks.example/forged",
          origin: "https://delegate.example",
          events: ["run.completed"],
          secretCiphertext: SEALED,
        }),
      /row-level security/,
    );
  });

  it("accepts only https URLs, known events and one endpoint per URL", async () => {
    const owner = await guest();
    const insert = (values: { url: string; events: string[] }) =>
      as(owner.userId, (tx) =>
        tx.insert(webhookEndpoints).values({
          workspaceId: owner.workspaceId,
          origin: "https://delegate.example",
          secretCiphertext: SEALED,
          ...values,
        }),
      );
    await expectDatabaseError(
      insert({ url: "http://hooks.example/plain", events: ["run.completed"] }),
      /webhook_endpoints_url_https/,
    );
    await expectDatabaseError(
      insert({ url: "https://hooks.example/a", events: [] }),
      /webhook_endpoints_events_known/,
    );
    await expectDatabaseError(
      insert({ url: "https://hooks.example/a", events: ["run.completed", "step.started"] }),
      /webhook_endpoints_events_known/,
    );
    await insert({ url: "https://hooks.example/once", events: ["run.completed"] });
    await expectDatabaseError(
      insert({ url: "https://hooks.example/once", events: ["run.failed"] }),
      /webhook_endpoints_workspace_url_unique/,
    );
  });

  it("keeps the URL and events fixed after creation, for every role", async () => {
    const owner = await guest();
    const id = await addEndpoint(owner);
    await refused(
      owner.userId,
      (tx) =>
        tx
          .update(webhookEndpoints)
          .set({ url: "https://attacker.example/x" })
          .where(eq(webhookEndpoints.id, id)),
      /permission denied/,
    );
    await expectDatabaseError(
      db
        .update(webhookEndpoints)
        .set({ url: "https://attacker.example/x" })
        .where(eq(webhookEndpoints.id, id)),
      /can only have its secret rotated/,
    );
    await expectDatabaseError(
      db
        .update(webhookEndpoints)
        .set({ events: ["run.failed"] })
        .where(eq(webhookEndpoints.id, id)),
      /can only have its secret rotated/,
    );
  });
});

const RUN_DATA = { run: { id: "run", status: "completed" } };

function enqueue(
  tenant: Tenant,
  runId: string,
  eventType = "run.completed" as const,
  key?: string,
) {
  return as(tenant.userId, (tx) =>
    enqueueWebhookDeliveries(tx, {
      runId,
      eventType,
      eventKey: key ?? `${runId}:${eventType}`,
      data: RUN_DATA,
    }),
  );
}

function claim(tenant: Tenant, options: { deliveryId?: string; maxAttempts?: number } = {}) {
  return as(tenant.userId, (tx) =>
    claimWebhookDeliveries(tx, {
      workspaceId: tenant.workspaceId,
      limit: 10,
      leaseSeconds: 60,
      maxAttempts: options.maxAttempts ?? 6,
      ...(options.deliveryId === undefined ? {} : { deliveryId: options.deliveryId }),
    }),
  );
}

async function delivery(id: string) {
  const [row] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id));
  if (row === undefined) throw new Error("delivery not found");
  return row;
}

async function expireLease(id: string) {
  await db
    .update(webhookDeliveries)
    .set({ lockedUntil: new Date(Date.now() - 1_000) })
    .where(eq(webhookDeliveries.id, id));
}

describe("webhook deliveries: enqueue", () => {
  it("creates one delivery per subscribed endpoint, once per event", async () => {
    const owner = await guest();
    const runId = await startRun(owner);
    const subscribed = await addEndpoint(owner, { events: ["run.completed", "run.failed"] });
    await addEndpoint(owner, { events: ["approval.requested"] });
    expect(await enqueue(owner, runId)).toBe(1);
    expect(await enqueue(owner, runId)).toBe(0);
    const rows = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.runId, runId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      endpointId: subscribed,
      workspaceId: owner.workspaceId,
      eventType: "run.completed",
      status: "pending",
      attempts: 0,
      data: RUN_DATA,
    });
    expect(rows[0]?.nextAttemptAt).toBeInstanceOf(Date);
  });

  it("returns zero without touching anything when the workspace has no endpoint", async () => {
    const owner = await guest();
    expect(await enqueue(owner, await startRun(owner))).toBe(0);
  });

  it("works for an operator's run", async () => {
    const owner = await guest();
    await addEndpoint(owner);
    const operator = await colleague(owner.workspaceId, "operator");
    expect(await enqueue(operator, await startRun(operator))).toBe(1);
  });

  it("refuses viewers, other workspaces and runs that do not exist with the same error", async () => {
    const owner = await guest();
    await addEndpoint(owner);
    const runId = await startRun(owner);
    const viewer = await colleague(owner.workspaceId, "viewer");
    const stranger = await guest();
    for (const [caller, target] of [
      [viewer, runId],
      [stranger, runId],
      [owner, crypto.randomUUID()],
    ] as const)
      await refused(
        caller.userId,
        (tx) =>
          enqueueWebhookDeliveries(tx, {
            runId: target,
            eventType: "run.completed",
            eventKey: "k",
            data: RUN_DATA,
          }),
        /only an operator of the run's workspace/,
      );
    expect(
      await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.runId, runId)),
    ).toEqual([]);
  });

  it("never enqueues to an endpoint of another workspace", async () => {
    const owner = await guest();
    const neighbour = await guest();
    const foreign = await addEndpoint(neighbour);
    await addEndpoint(owner);
    const runId = await startRun(owner);
    await enqueue(owner, runId);
    const rows = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.runId, runId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.endpointId).not.toBe(foreign);
    await expectDatabaseError(
      db.insert(webhookDeliveries).values({
        workspaceId: owner.workspaceId,
        endpointId: foreign,
        eventType: "run.completed",
        eventKey: "cross-workspace",
        data: {},
        nextAttemptAt: new Date(),
      }),
      /webhook_deliveries_endpoint_fk/,
    );
  });

  it("refuses unknown event types and oversized or non-object data", async () => {
    const owner = await guest();
    await addEndpoint(owner);
    const runId = await startRun(owner);
    const raw = (type: string, data: string) =>
      as(owner.userId, (tx) =>
        tx.execute(
          sql`select enqueue_webhook_deliveries(${runId}::uuid, ${type}, 'k', ${data}::jsonb)`,
        ),
      );
    await expectDatabaseError(raw("step.started", "{}"), /unknown webhook event type/);
    await expectDatabaseError(raw("webhook.test", "{}"), /unknown webhook event type/);
    await expectDatabaseError(raw("run.completed", "[1]"), /must be a JSON object/);
    await expectDatabaseError(
      raw("run.completed", JSON.stringify({ blob: "x".repeat(33_000) })),
      /at most 32 KB/,
    );
  });

  it("drops settled deliveries older than thirty days when the next event arrives", async () => {
    const owner = await guest();
    await addEndpoint(owner);
    const oldRun = await startRun(owner);
    await enqueue(owner, oldRun);
    const [claimed] = await claim(owner);
    if (claimed === undefined) throw new Error("nothing claimed");
    await as(owner.userId, (tx) =>
      settleWebhookDelivery(tx, {
        deliveryId: claimed.deliveryId,
        attempt: 1,
        outcome: "delivered",
        statusCode: 200,
      }),
    );
    await db
      .update(webhookDeliveries)
      .set({ createdAt: new Date(Date.now() - 31 * 86_400_000) })
      .where(eq(webhookDeliveries.id, claimed.deliveryId));
    await enqueue(owner, await startRun(owner));
    expect(
      await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.runId, oldRun)),
    ).toEqual([]);
  });
});

describe("webhook deliveries: claim and settle", () => {
  it("claims a due delivery with what the sender needs, under a lease", async () => {
    const owner = await guest();
    const endpointId = await addEndpoint(owner, { url: "https://hooks.example/claim" });
    const runId = await startRun(owner);
    await enqueue(owner, runId);
    const claimed = await claim(owner);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      endpointId,
      url: "https://hooks.example/claim",
      origin: "https://delegate.example",
      secretCiphertext: SEALED,
      eventType: "run.completed",
      data: RUN_DATA,
      attempt: 1,
    });
    expect(claimed[0]?.createdAt).toBeInstanceOf(Date);
    expect(await claim(owner)).toEqual([]);
    const row = await delivery(claimed[0]?.deliveryId ?? "");
    expect(row.attempts).toBe(1);
    expect(row.lockedUntil?.getTime()).toBeGreaterThan(Date.now());
    expect(row.lastAttemptAt).toBeInstanceOf(Date);
  });

  it("hands an expired lease to the next worker as the next attempt", async () => {
    const owner = await guest();
    await addEndpoint(owner);
    await enqueue(owner, await startRun(owner));
    const [first] = await claim(owner);
    if (first === undefined) throw new Error("nothing claimed");
    await expireLease(first.deliveryId);
    const [second] = await claim(owner);
    expect(second).toMatchObject({ deliveryId: first.deliveryId, attempt: 2 });
  });

  it("marks a delivery delivered and stops offering it", async () => {
    const owner = await guest();
    await addEndpoint(owner);
    await enqueue(owner, await startRun(owner));
    const [claimed] = await claim(owner);
    if (claimed === undefined) throw new Error("nothing claimed");
    expect(
      await as(owner.userId, (tx) =>
        settleWebhookDelivery(tx, {
          deliveryId: claimed.deliveryId,
          attempt: 1,
          outcome: "delivered",
          statusCode: 204,
          excerpt: "",
        }),
      ),
    ).toBe(true);
    const row = await delivery(claimed.deliveryId);
    expect(row).toMatchObject({
      status: "delivered",
      lastStatusCode: 204,
      lastError: null,
      nextAttemptAt: null,
      lockedUntil: null,
    });
    expect(row.deliveredAt).toBeInstanceOf(Date);
    expect(await claim(owner)).toEqual([]);
  });

  it("schedules a retry and offers the delivery again only when it is due", async () => {
    const owner = await guest();
    await addEndpoint(owner);
    await enqueue(owner, await startRun(owner));
    const [claimed] = await claim(owner);
    if (claimed === undefined) throw new Error("nothing claimed");
    const nextAttemptAt = new Date(Date.now() + 60_000);
    await as(owner.userId, (tx) =>
      settleWebhookDelivery(tx, {
        deliveryId: claimed.deliveryId,
        attempt: 1,
        outcome: "retry",
        statusCode: 503,
        error: "http_error",
        excerpt: "Service Unavailable",
        nextAttemptAt,
      }),
    );
    expect(await delivery(claimed.deliveryId)).toMatchObject({
      status: "pending",
      attempts: 1,
      lastStatusCode: 503,
      lastError: "http_error",
      lastResponseExcerpt: "Service Unavailable",
      lockedUntil: null,
      deliveredAt: null,
    });
    expect(await claim(owner)).toEqual([]);
    await db
      .update(webhookDeliveries)
      .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
      .where(eq(webhookDeliveries.id, claimed.deliveryId));
    expect(await claim(owner)).toMatchObject([{ deliveryId: claimed.deliveryId, attempt: 2 }]);
  });

  it("marks a delivery failed for good", async () => {
    const owner = await guest();
    await addEndpoint(owner);
    await enqueue(owner, await startRun(owner));
    const [claimed] = await claim(owner);
    if (claimed === undefined) throw new Error("nothing claimed");
    await as(owner.userId, (tx) =>
      settleWebhookDelivery(tx, {
        deliveryId: claimed.deliveryId,
        attempt: 1,
        outcome: "failed",
        statusCode: null,
        error: "timeout",
      }),
    );
    expect(await delivery(claimed.deliveryId)).toMatchObject({
      status: "failed",
      lastError: "timeout",
      lastStatusCode: null,
      nextAttemptAt: null,
    });
    expect(await claim(owner)).toEqual([]);
  });

  it("ignores a stale worker that settles an older attempt", async () => {
    const owner = await guest();
    await addEndpoint(owner);
    await enqueue(owner, await startRun(owner));
    const [first] = await claim(owner);
    if (first === undefined) throw new Error("nothing claimed");
    await expireLease(first.deliveryId);
    await claim(owner);
    expect(
      await as(owner.userId, (tx) =>
        settleWebhookDelivery(tx, {
          deliveryId: first.deliveryId,
          attempt: 1,
          outcome: "delivered",
          statusCode: 200,
        }),
      ),
    ).toBe(false);
    expect(await delivery(first.deliveryId)).toMatchObject({ status: "pending", attempts: 2 });
  });

  it("stores at most 200 characters of the response and 60 of the error", async () => {
    const owner = await guest();
    await addEndpoint(owner);
    await enqueue(owner, await startRun(owner));
    const [claimed] = await claim(owner);
    if (claimed === undefined) throw new Error("nothing claimed");
    await as(owner.userId, (tx) =>
      tx.execute(
        sql`select settle_webhook_delivery(${claimed.deliveryId}::uuid, 1, 'failed', 500, ${"e".repeat(500)}, ${"r".repeat(5_000)}, null)`,
      ),
    );
    const row = await delivery(claimed.deliveryId);
    expect(row.lastResponseExcerpt).toHaveLength(200);
    expect(row.lastError).toHaveLength(60);
    await expectDatabaseError(
      db
        .update(webhookDeliveries)
        .set({ lastResponseExcerpt: "r".repeat(201) })
        .where(eq(webhookDeliveries.id, claimed.deliveryId)),
      /webhook_deliveries_excerpt_short/,
    );
  });

  it("closes a delivery whose attempts ran out without being settled", async () => {
    const owner = await guest();
    await addEndpoint(owner);
    await enqueue(owner, await startRun(owner));
    const [first] = await claim(owner, { maxAttempts: 2 });
    if (first === undefined) throw new Error("nothing claimed");
    await expireLease(first.deliveryId);
    await claim(owner, { maxAttempts: 2 });
    await expireLease(first.deliveryId);
    expect(await claim(owner, { maxAttempts: 2 })).toEqual([]);
    expect(await delivery(first.deliveryId)).toMatchObject({
      status: "failed",
      attempts: 2,
      lastError: "abandoned",
      nextAttemptAt: null,
    });
  });

  it("refuses a retry without a future time and unknown outcomes", async () => {
    const owner = await guest();
    await addEndpoint(owner);
    await enqueue(owner, await startRun(owner));
    const [claimed] = await claim(owner);
    if (claimed === undefined) throw new Error("nothing claimed");
    const settle = (outcome: string, next: string | null) =>
      as(owner.userId, (tx) =>
        tx.execute(
          sql`select settle_webhook_delivery(${claimed.deliveryId}::uuid, 1, ${outcome}, 500, 'x', 'x', ${next}::timestamptz)`,
        ),
      );
    await expectDatabaseError(settle("retry", null), /next attempt time in the future/);
    await expectDatabaseError(
      settle("retry", new Date(Date.now() - 60_000).toISOString()),
      /next attempt time in the future/,
    );
    await expectDatabaseError(settle("skipped", null), /unknown webhook delivery outcome/);
  });

  it("never lets another workspace or a viewer claim or settle", async () => {
    const owner = await guest();
    await addEndpoint(owner);
    await enqueue(owner, await startRun(owner));
    const stranger = await guest();
    const viewer = await colleague(owner.workspaceId, "viewer");
    for (const outsider of [stranger, viewer])
      await refused(
        outsider.userId,
        (tx) =>
          claimWebhookDeliveries(tx, {
            workspaceId: owner.workspaceId,
            limit: 10,
            leaseSeconds: 60,
            maxAttempts: 6,
          }),
        /only an operator of the workspace may deliver/,
      );
    expect(await claim(stranger)).toEqual([]);
    const [claimed] = await claim(owner);
    if (claimed === undefined) throw new Error("nothing claimed");
    for (const outsider of [stranger, viewer])
      await refused(
        outsider.userId,
        (tx) =>
          settleWebhookDelivery(tx, {
            deliveryId: claimed.deliveryId,
            attempt: 1,
            outcome: "delivered",
            statusCode: 200,
          }),
        /only an operator of the workspace may record/,
      );
    await refused(
      stranger.userId,
      (tx) =>
        settleWebhookDelivery(tx, {
          deliveryId: crypto.randomUUID(),
          attempt: 1,
          outcome: "delivered",
          statusCode: 200,
        }),
      /only an operator of the workspace may record/,
    );
    expect(await delivery(claimed.deliveryId)).toMatchObject({ status: "pending" });
  });

  it("lets an operator deliver without being able to list endpoints", async () => {
    const owner = await guest();
    await addEndpoint(owner);
    const operator = await colleague(owner.workspaceId, "operator");
    await enqueue(operator, await startRun(operator));
    const [claimed] = await claim(operator);
    expect(claimed?.secretCiphertext).toBe(SEALED);
    expect(
      await as(operator.userId, (tx) => tx.select(endpointColumns).from(webhookEndpoints)),
    ).toEqual([]);
  });
});

describe("webhook deliveries: test events, visibility and cleanup", () => {
  it("sends a test delivery for an admin, claimable by id at once", async () => {
    const owner = await guest();
    const endpointId = await addEndpoint(owner, { events: ["approval.requested"] });
    const deliveryId = await as(owner.userId, (tx) =>
      enqueueWebhookTest(tx, { endpointId, data: { message: "ping" } }),
    );
    const claimed = await claim(owner, { deliveryId });
    expect(claimed).toMatchObject([
      { deliveryId, endpointId, eventType: "webhook.test", data: { message: "ping" }, attempt: 1 },
    ]);
    expect((await delivery(deliveryId)).runId).toBeNull();
  });

  it("refuses a test delivery from operators and from other workspaces", async () => {
    const owner = await guest();
    const endpointId = await addEndpoint(owner);
    for (const outsider of [await colleague(owner.workspaceId, "operator"), await guest()])
      await refused(
        outsider.userId,
        (tx) => enqueueWebhookTest(tx, { endpointId, data: { message: "ping" } }),
        /only an admin of the endpoint's workspace/,
      );
    await refused(
      owner.userId,
      (tx) => enqueueWebhookTest(tx, { endpointId: crypto.randomUUID(), data: {} }),
      /only an admin of the endpoint's workspace/,
    );
  });

  it("shows the delivery log to admins only", async () => {
    const owner = await guest();
    await addEndpoint(owner);
    const runId = await startRun(owner);
    await enqueue(owner, runId);
    const visibleTo = (tenant: Tenant) =>
      as(tenant.userId, (tx) =>
        tx
          .select({ id: webhookDeliveries.id })
          .from(webhookDeliveries)
          .where(eq(webhookDeliveries.runId, runId)),
      );
    expect(await visibleTo(owner)).toHaveLength(1);
    expect(await visibleTo(await colleague(owner.workspaceId, "admin"))).toHaveLength(1);
    expect(await visibleTo(await colleague(owner.workspaceId, "operator"))).toEqual([]);
    expect(await visibleTo(await colleague(owner.workspaceId, "viewer"))).toEqual([]);
    expect(await visibleTo(await guest())).toEqual([]);
  });

  it("refuses direct writes to the delivery log, even from the workspace owner", async () => {
    const owner = await guest();
    const endpointId = await addEndpoint(owner);
    await enqueue(owner, await startRun(owner));
    await refused(
      owner.userId,
      (tx) =>
        tx.insert(webhookDeliveries).values({
          workspaceId: owner.workspaceId,
          endpointId,
          eventType: "run.completed",
          eventKey: "forged",
          data: {},
          nextAttemptAt: new Date(),
        }),
      /permission denied/,
    );
    await refused(
      owner.userId,
      (tx) => tx.update(webhookDeliveries).set({ status: "delivered" }),
      /permission denied/,
    );
    await refused(owner.userId, (tx) => tx.delete(webhookDeliveries), /permission denied/);
  });

  it("deletes an endpoint's deliveries with the endpoint", async () => {
    const owner = await guest();
    const endpointId = await addEndpoint(owner);
    await enqueue(owner, await startRun(owner));
    await as(owner.userId, (tx) =>
      tx.delete(webhookEndpoints).where(eq(webhookEndpoints.id, endpointId)),
    );
    expect(
      await db
        .select()
        .from(webhookDeliveries)
        .where(
          and(
            eq(webhookDeliveries.endpointId, endpointId),
            eq(webhookDeliveries.workspaceId, owner.workspaceId),
          ),
        ),
    ).toEqual([]);
  });
});

describe("migration 0011 privileges", () => {
  it("forces row-level security on the three tables", async () => {
    const result = await db.execute(
      sql`select relname, relrowsecurity, relforcerowsecurity from pg_class
          where relname in ('webhook_endpoints', 'webhook_deliveries', 'idempotency_keys')
          order by relname`,
    );
    expect(result.rows).toEqual([
      { relname: "idempotency_keys", relrowsecurity: true, relforcerowsecurity: true },
      { relname: "webhook_deliveries", relrowsecurity: true, relforcerowsecurity: true },
      { relname: "webhook_endpoints", relrowsecurity: true, relforcerowsecurity: true },
    ]);
  });

  it("hands the functions to delegate_definer and lets only delegate_app call them", async () => {
    const result = await db.execute(
      sql`select p.proname, r.rolname as owner, p.prosecdef,
            has_function_privilege('delegate_app', p.oid, 'execute') as app,
            has_function_privilege('public', p.oid, 'execute') as everyone
          from pg_proc p join pg_roles r on r.oid = p.proowner
          where p.proname in (
            'idempotency_begin', 'idempotency_complete', 'idempotency_release',
            'enqueue_webhook_deliveries', 'enqueue_webhook_test',
            'claim_webhook_deliveries', 'settle_webhook_delivery'
          )
          order by p.proname`,
    );
    expect(result.rows).toHaveLength(7);
    for (const row of result.rows)
      expect(row).toMatchObject({
        owner: "delegate_definer",
        prosecdef: true,
        app: true,
        everyone: false,
      });
  });

  it("leaves delegate_definer without the right to create in the public schema", async () => {
    const result = await db.execute(
      sql`select has_schema_privilege('delegate_definer', 'public', 'create') as can_create`,
    );
    expect(result.rows).toEqual([{ can_create: false }]);
  });
});
