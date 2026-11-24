import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { recordAudit, withTenant } from "./client";
import { auditLog, users } from "./schema";
import { seedMember, seedUser, seedWorkspaceContent } from "./testing/fixtures";
import {
  asAppLogin,
  asSessionRole,
  createTestDb,
  expectDatabaseError,
  type TestDb,
} from "./testing/pglite";

describe("audit_log writes", () => {
  let harness: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let mine: Awaited<ReturnType<typeof seedWorkspaceContent>>;
  let theirs: Awaited<ReturnType<typeof seedWorkspaceContent>>;
  const ids = { owner: "", viewer: "", agent: "", stranger: "" };

  beforeAll(async () => {
    harness = await createTestDb();
    db = harness.db;
    for (const name of Object.keys(ids) as (keyof typeof ids)[]) {
      ids[name] = (await seedUser(db, name)).id;
    }
    await db.update(users).set({ kind: "agent" }).where(eq(users.id, ids.agent));
    mine = await seedWorkspaceContent(db, "audited", ids.owner);
    theirs = await seedWorkspaceContent(db, "foreign", ids.stranger);
    await seedMember(db, mine.workspace.id, ids.owner, "owner");
    await seedMember(db, mine.workspace.id, ids.viewer, "viewer");
    await seedMember(db, mine.workspace.id, ids.agent, "operator");
    await seedMember(db, theirs.workspace.id, ids.stranger, "owner");
    await db.execute(sql`create role worker_login login noinherit`);
    await db.execute(sql`grant delegate_app, delegate_system to worker_login`);
  });

  afterAll(async () => {
    await harness.client.close();
  });

  const entry = (workspaceId: string) => ({
    workspaceId,
    action: "run.viewed",
    target: "run:1",
    decision: "n/a" as const,
  });

  it("denies a direct INSERT, even to the workspace owner", async () => {
    await expectDatabaseError(
      asAppLogin(db, () =>
        withTenant(db, ids.owner, (tx) =>
          tx.insert(auditLog).values({
            workspaceId: mine.workspace.id,
            actorType: "user",
            actorId: ids.stranger,
            action: "forged",
            decision: "allow",
          }),
        ),
      ),
      /permission denied for table audit_log/,
    );
  });

  it("records a member's own action with the actor taken from app.user_id", async () => {
    const id = await asAppLogin(db, () =>
      withTenant(db, ids.viewer, (tx) => recordAudit(tx, entry(mine.workspace.id))),
    );
    const [row] = await db.select().from(auditLog).where(eq(auditLog.id, id));
    expect(row).toMatchObject({
      workspaceId: mine.workspace.id,
      actorType: "user",
      actorId: ids.viewer,
      action: "run.viewed",
      decision: "n/a",
    });
  });

  it("does not let a viewer forge a system or agent entry", async () => {
    for (const actorType of ["system", "agent"] as const) {
      await expectDatabaseError(
        asAppLogin(db, () =>
          withTenant(db, ids.viewer, (tx) =>
            recordAudit(tx, { ...entry(mine.workspace.id), actorType }),
          ),
        ),
        /entries require the delegate_system role/,
      );
    }
  });

  it("does not let a member write into another workspace", async () => {
    await expectDatabaseError(
      asAppLogin(db, () =>
        withTenant(db, ids.viewer, (tx) => recordAudit(tx, entry(theirs.workspace.id))),
      ),
      /not a member of workspace/,
    );
  });

  it("does not let an entry reference another workspace's policy or approval", async () => {
    await expectDatabaseError(
      asAppLogin(db, () =>
        withTenant(db, ids.owner, (tx) =>
          recordAudit(tx, { ...entry(mine.workspace.id), policyId: theirs.policy.id }),
        ),
      ),
      /policy .* does not belong to workspace/,
    );
    await expectDatabaseError(
      asAppLogin(db, () =>
        withTenant(db, ids.owner, (tx) =>
          recordAudit(tx, { ...entry(mine.workspace.id), approvalId: theirs.approval.id }),
        ),
      ),
      /approval .* does not belong to workspace/,
    );
  });

  it("lets a login holding delegate_system record system and agent entries", async () => {
    const systemId = await asSessionRole(db, "worker_login", () =>
      withTenant(db, ids.agent, (tx) =>
        recordAudit(tx, { ...entry(mine.workspace.id), actorType: "system", decision: "allow" }),
      ),
    );
    const agentId = await asSessionRole(db, "worker_login", () =>
      withTenant(db, ids.agent, (tx) =>
        recordAudit(tx, { ...entry(mine.workspace.id), actorType: "agent", decision: "deny" }),
      ),
    );
    const rows = await db
      .select({ id: auditLog.id, actorType: auditLog.actorType, actorId: auditLog.actorId })
      .from(auditLog)
      .where(sql`${auditLog.id} in (${systemId}, ${agentId})`)
      .orderBy(auditLog.id);
    expect(rows).toEqual([
      { id: systemId, actorType: "system", actorId: null },
      { id: agentId, actorType: "agent", actorId: ids.agent },
    ]);
  });

  it("requires an agent entry to come from an agent identity", async () => {
    await expectDatabaseError(
      asSessionRole(db, "worker_login", () =>
        withTenant(db, ids.owner, (tx) =>
          recordAudit(tx, { ...entry(mine.workspace.id), actorType: "agent" }),
        ),
      ),
      /agent entries require an agent identity/,
    );
  });
});
