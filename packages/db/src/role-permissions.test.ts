import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withTenant } from "./client";
import { approvals, members, policies, runs } from "./schema";
import { seedMember, seedUser, seedWorkspaceContent } from "./testing/fixtures";
import { createTestDb, expectDatabaseError, type TestDb } from "./testing/pglite";

const rlsViolation = /row-level security/;

describe("role permissions inside a workspace", () => {
  let harness: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let seeded: Awaited<ReturnType<typeof seedWorkspaceContent>>;
  const ids = { owner: "", admin: "", operator: "", viewer: "", outsider: "" };

  beforeAll(async () => {
    harness = await createTestDb();
    db = harness.db;
    for (const name of Object.keys(ids) as (keyof typeof ids)[]) {
      ids[name] = (await seedUser(db, name)).id;
    }
    seeded = await seedWorkspaceContent(db, "roles", ids.owner);
    await seedMember(db, seeded.workspace.id, ids.owner, "owner");
    await seedMember(db, seeded.workspace.id, ids.admin, "admin");
    await seedMember(db, seeded.workspace.id, ids.operator, "operator");
    await seedMember(db, seeded.workspace.id, ids.viewer, "viewer");
  });

  afterAll(async () => {
    await harness.client.close();
  });

  const newRun = () => ({
    workspaceId: seeded.workspace.id,
    mission: "xray",
    input: { company: "example" },
  });

  it("lets a viewer read runs", async () => {
    const visible = await withTenant(db, ids.viewer, (tx) => tx.select({ id: runs.id }).from(runs));
    expect(visible.map((row) => row.id)).toContain(seeded.run.id);
  });

  it("does not let a viewer create a run", async () => {
    await expectDatabaseError(
      withTenant(db, ids.viewer, (tx) => tx.insert(runs).values(newRun())),
      rlsViolation,
    );
  });

  it("lets an operator create a run", async () => {
    const [created] = await withTenant(db, ids.operator, (tx) =>
      tx
        .insert(runs)
        .values({ ...newRun(), createdBy: ids.operator })
        .returning(),
    );
    expect(created?.workspaceId).toBe(seeded.workspace.id);
    expect(created?.status).toBe("pending");
  });

  it("does not let a viewer resolve an approval", async () => {
    const updated = await withTenant(db, ids.viewer, (tx) =>
      tx
        .update(approvals)
        .set({ status: "approved", resolvedAt: new Date(), resolvedBy: ids.viewer })
        .where(eq(approvals.id, seeded.approval.id))
        .returning({ id: approvals.id }),
    );
    expect(updated).toHaveLength(0);
  });

  it("lets an operator resolve an approval", async () => {
    const updated = await withTenant(db, ids.operator, (tx) =>
      tx
        .update(approvals)
        .set({ status: "approved", resolvedAt: new Date(), resolvedBy: ids.operator })
        .where(eq(approvals.id, seeded.approval.id))
        .returning({ id: approvals.id }),
    );
    expect(updated).toHaveLength(1);
  });

  it("does not let an operator manage policies", async () => {
    await expectDatabaseError(
      withTenant(db, ids.operator, (tx) =>
        tx
          .insert(policies)
          .values({ workspaceId: seeded.workspace.id, name: "egress", definition: {} }),
      ),
      rlsViolation,
    );
  });

  it("lets an admin manage policies", async () => {
    const [created] = await withTenant(db, ids.admin, (tx) =>
      tx
        .insert(policies)
        .values({ workspaceId: seeded.workspace.id, name: "egress", definition: { allow: [] } })
        .returning(),
    );
    expect(created?.name).toBe("egress");
  });

  it("does not let an operator add members", async () => {
    await expectDatabaseError(
      withTenant(db, ids.operator, (tx) =>
        tx
          .insert(members)
          .values({ workspaceId: seeded.workspace.id, userId: ids.outsider, role: "viewer" }),
      ),
      rlsViolation,
    );
  });

  it("lets an admin add a member below owner but not grant owner", async () => {
    await expectDatabaseError(
      withTenant(db, ids.admin, (tx) =>
        tx
          .insert(members)
          .values({ workspaceId: seeded.workspace.id, userId: ids.outsider, role: "owner" }),
      ),
      rlsViolation,
    );
    const [added] = await withTenant(db, ids.admin, (tx) =>
      tx
        .insert(members)
        .values({ workspaceId: seeded.workspace.id, userId: ids.outsider, role: "operator" })
        .returning(),
    );
    expect(added?.role).toBe("operator");
  });

  it("does not let an admin demote the owner", async () => {
    const updated = await withTenant(db, ids.admin, (tx) =>
      tx
        .update(members)
        .set({ role: "viewer" })
        .where(eq(members.userId, ids.owner))
        .returning({ id: members.id }),
    );
    expect(updated).toHaveLength(0);
  });

  it("does not let a member change their own user kind", async () => {
    await expectDatabaseError(
      withTenant(db, ids.viewer, (tx) => tx.execute("update users set kind = 'agent'")),
      /permission denied for table users/,
    );
  });
});
