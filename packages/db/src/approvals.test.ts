import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveApproval, withTenant } from "./client";
import { approvalStatus, approvals, runs, users } from "./schema";
import { seedMember, seedUser, seedWorkspaceContent } from "./testing/fixtures";
import { createTestDb, expectDatabaseError, type TestDb } from "./testing/pglite";

describe("approvals", () => {
  let harness: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let seeded: Awaited<ReturnType<typeof seedWorkspaceContent>>;
  const ids = {
    owner: "",
    admin: "",
    operator: "",
    second: "",
    viewer: "",
    agent: "",
    outsider: "",
  };

  beforeAll(async () => {
    harness = await createTestDb();
    db = harness.db;
    for (const name of Object.keys(ids) as (keyof typeof ids)[]) {
      ids[name] = (await seedUser(db, name)).id;
    }
    await db.update(users).set({ kind: "agent" }).where(eq(users.id, ids.agent));
    seeded = await seedWorkspaceContent(db, "approvals", ids.owner);
    await seedMember(db, seeded.workspace.id, ids.owner, "owner");
    await seedMember(db, seeded.workspace.id, ids.admin, "admin");
    await seedMember(db, seeded.workspace.id, ids.operator, "operator");
    await seedMember(db, seeded.workspace.id, ids.second, "operator");
    await seedMember(db, seeded.workspace.id, ids.viewer, "viewer");
    await seedMember(db, seeded.workspace.id, ids.agent, "operator");
    const other = await seedWorkspaceContent(db, "elsewhere", ids.outsider);
    await seedMember(db, other.workspace.id, ids.outsider, "owner");
  });

  afterAll(async () => {
    await harness.client.close();
  });

  async function pendingApproval(createdBy: string) {
    const [run] = await db
      .insert(runs)
      .values({ workspaceId: seeded.workspace.id, mission: "xray", input: {}, createdBy })
      .returning();
    if (!run) throw new Error("run not created");
    const [approval] = await db
      .insert(approvals)
      .values({
        runId: run.id,
        workspaceId: seeded.workspace.id,
        stepId: "step-1",
        action: { tool: "github.create_pr" },
      })
      .returning();
    if (!approval) throw new Error("approval not created");
    return approval;
  }

  it("uses the runtime's resolution vocabulary", () => {
    expect(approvalStatus.enumValues).toEqual(["pending", "approved", "rejected", "expired"]);
  });

  it("denies a direct UPDATE to every role, so status and approver cannot be spoofed", async () => {
    const approval = await pendingApproval(ids.owner);
    for (const actor of [ids.owner, ids.operator]) {
      await expectDatabaseError(
        withTenant(db, actor, (tx) =>
          tx
            .update(approvals)
            .set({ status: "approved", resolvedAt: new Date(), resolvedBy: ids.second })
            .where(eq(approvals.id, approval.id)),
        ),
        /permission denied for table approvals/,
      );
    }
  });

  it("lets an operator approve another member's run and records them as the approver", async () => {
    const approval = await pendingApproval(ids.owner);
    const resolved = await withTenant(db, ids.operator, (tx) =>
      resolveApproval(tx, approval.id, "approved"),
    );
    expect(resolved).toMatchObject({
      id: approval.id,
      status: "approved",
      resolvedBy: ids.operator,
    });
    expect(resolved.resolvedAt).toBeInstanceOf(Date);
  });

  it("writes an audit row attributed to the approver", async () => {
    const approval = await pendingApproval(ids.owner);
    await withTenant(db, ids.second, (tx) => resolveApproval(tx, approval.id, "rejected"));
    const rows = await db.execute(
      sql`select actor_type, actor_id, action, approval_id from audit_log where approval_id = ${approval.id}`,
    );
    expect(rows.rows).toEqual([
      {
        actor_type: "user",
        actor_id: ids.second,
        action: "approval.rejected",
        approval_id: approval.id,
      },
    ]);
  });

  it("does not let an operator approve an action on a run they created", async () => {
    const approval = await pendingApproval(ids.operator);
    await expectDatabaseError(
      withTenant(db, ids.operator, (tx) => resolveApproval(tx, approval.id, "approved")),
      /cannot approve an action on a run they created/,
    );
  });

  it("lets an operator reject an action on their own run", async () => {
    const approval = await pendingApproval(ids.operator);
    const resolved = await withTenant(db, ids.operator, (tx) =>
      resolveApproval(tx, approval.id, "rejected"),
    );
    expect(resolved.status).toBe("rejected");
  });

  it("lets an admin approve their own run", async () => {
    const approval = await pendingApproval(ids.admin);
    const resolved = await withTenant(db, ids.admin, (tx) =>
      resolveApproval(tx, approval.id, "approved"),
    );
    expect(resolved).toMatchObject({ status: "approved", resolvedBy: ids.admin });
  });

  it("does not let a viewer resolve", async () => {
    const approval = await pendingApproval(ids.owner);
    await expectDatabaseError(
      withTenant(db, ids.viewer, (tx) => resolveApproval(tx, approval.id, "approved")),
      /requires operator/,
    );
  });

  it("does not let an agent identity resolve, even with an operator role", async () => {
    const approval = await pendingApproval(ids.owner);
    await expectDatabaseError(
      withTenant(db, ids.agent, (tx) => resolveApproval(tx, approval.id, "approved")),
      /agents cannot resolve approvals/,
    );
  });

  it("does not reveal or resolve approvals in another workspace", async () => {
    const approval = await pendingApproval(ids.owner);
    await expectDatabaseError(
      withTenant(db, ids.outsider, (tx) => resolveApproval(tx, approval.id, "approved")),
      /approval not found/,
    );
  });

  it("cannot resolve twice or re-open", async () => {
    const approval = await pendingApproval(ids.owner);
    await withTenant(db, ids.operator, (tx) => resolveApproval(tx, approval.id, "rejected"));
    await expectDatabaseError(
      withTenant(db, ids.admin, (tx) => resolveApproval(tx, approval.id, "approved")),
      /approval is already rejected/,
    );
    await expectDatabaseError(
      db
        .update(approvals)
        .set({ status: "pending", resolvedAt: null, resolvedBy: null })
        .where(eq(approvals.id, approval.id)),
      /approvals: a resolved approval cannot change/,
    );
  });

  it("rejects decisions outside approved|rejected", async () => {
    const approval = await pendingApproval(ids.owner);
    await expectDatabaseError(
      withTenant(db, ids.operator, (tx) =>
        tx.execute(sql`select * from resolve_approval(${approval.id}::uuid, 'expired')`),
      ),
      /decision must be approved or rejected/,
    );
  });

  it("keeps action, run, step and workspace immutable even for the table owner", async () => {
    const approval = await pendingApproval(ids.owner);
    await expectDatabaseError(
      db
        .update(approvals)
        .set({ action: { tool: "noop" } })
        .where(eq(approvals.id, approval.id)),
      /approvals\.action is immutable/,
    );
    await expectDatabaseError(
      db.update(approvals).set({ stepId: "step-2" }).where(eq(approvals.id, approval.id)),
      /approvals\.step_id is immutable/,
    );
  });

  it("only accepts new approvals in the pending state", async () => {
    await expectDatabaseError(
      withTenant(db, ids.operator, (tx) =>
        tx.insert(approvals).values({
          runId: seeded.run.id,
          workspaceId: seeded.workspace.id,
          stepId: "step-9",
          action: {},
          status: "approved",
          resolvedAt: new Date(),
          resolvedBy: ids.operator,
        }),
      ),
      /row-level security/,
    );
  });
});
