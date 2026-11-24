import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { visibleUserEmail, withTenant } from "./client";
import { members, orgs, users, workspaces } from "./schema";
import { seedMember, seedUser } from "./testing/fixtures";
import { createTestDb, expectDatabaseError, type TestDb } from "./testing/pglite";

describe("members and users", () => {
  let harness: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let orgId: string;

  beforeAll(async () => {
    harness = await createTestDb();
    db = harness.db;
    const [org] = await db.insert(orgs).values({ name: "Owners", slug: "owners" }).returning();
    if (!org) throw new Error("org not created");
    orgId = org.id;
  });

  afterAll(async () => {
    await harness.client.close();
  });

  async function workspaceWith(
    slug: string,
    roles: Record<string, "owner" | "admin" | "operator" | "viewer">,
  ) {
    const [workspace] = await db.insert(workspaces).values({ orgId, name: slug, slug }).returning();
    if (!workspace) throw new Error("workspace not created");
    const ids: Record<string, string> = {};
    for (const [name, role] of Object.entries(roles)) {
      const user = await seedUser(db, `${slug}-${name}`);
      await seedMember(db, workspace.id, user.id, role);
      ids[name] = user.id;
    }
    return { workspace, ids };
  }

  const need = (ids: Record<string, string>, name: string) => {
    const id = ids[name];
    if (id === undefined) throw new Error(`no user ${name}`);
    return id;
  };

  describe("last owner", () => {
    it("cannot leave the workspace", async () => {
      const { workspace, ids } = await workspaceWith("solo", { owner: "owner" });
      const owner = need(ids, "owner");
      await expectDatabaseError(
        withTenant(db, owner, (tx) =>
          tx
            .delete(members)
            .where(and(eq(members.workspaceId, workspace.id), eq(members.userId, owner))),
        ),
        /must keep at least one owner/,
      );
    });

    it("cannot be demoted", async () => {
      const { workspace, ids } = await workspaceWith("demote", { owner: "owner" });
      const owner = need(ids, "owner");
      await expectDatabaseError(
        withTenant(db, owner, (tx) =>
          tx
            .update(members)
            .set({ role: "admin" })
            .where(and(eq(members.workspaceId, workspace.id), eq(members.userId, owner))),
        ),
        /must keep at least one owner/,
      );
    });

    it("can step down once another owner exists", async () => {
      const { workspace, ids } = await workspaceWith("pair", { first: "owner", second: "owner" });
      const first = need(ids, "first");
      const updated = await withTenant(db, first, (tx) =>
        tx
          .update(members)
          .set({ role: "admin" })
          .where(and(eq(members.workspaceId, workspace.id), eq(members.userId, first)))
          .returning({ role: members.role }),
      );
      expect(updated).toEqual([{ role: "admin" }]);
    });

    it("blocks deleting the user who is the last owner", async () => {
      const { ids } = await workspaceWith("leaver", { owner: "owner" });
      await expectDatabaseError(
        db.delete(users).where(eq(users.id, need(ids, "owner"))),
        /must keep at least one owner/,
      );
    });

    it("does not block deleting the workspace itself", async () => {
      const { workspace } = await workspaceWith("doomed", { owner: "owner", viewer: "viewer" });
      await db.delete(workspaces).where(eq(workspaces.id, workspace.id));
      const left = await db.select().from(members).where(eq(members.workspaceId, workspace.id));
      expect(left).toEqual([]);
    });
  });

  describe("user email", () => {
    let ids: Record<string, string>;
    let strangerId: string;

    beforeAll(async () => {
      ({ ids } = await workspaceWith("emails", {
        admin: "admin",
        viewer: "viewer",
        operator: "operator",
        owner: "owner",
      }));
      strangerId = (await seedUser(db, "stranger")).id;
    });

    it("is not selectable directly by delegate_app", async () => {
      await expectDatabaseError(
        withTenant(db, need(ids, "viewer"), (tx) => tx.execute(sql`select email from users`)),
        /permission denied for table users/,
      );
    });

    it("leaves the other user columns readable", async () => {
      const rows = await withTenant(db, need(ids, "viewer"), (tx) =>
        tx.select({ id: users.id, displayName: users.displayName, kind: users.kind }).from(users),
      );
      expect(rows.map((row) => row.id).sort()).toEqual(Object.values(ids).sort());
    });

    it("is visible to the user themselves", async () => {
      const email = await withTenant(db, need(ids, "viewer"), (tx) =>
        visibleUserEmail(tx, need(ids, "viewer")),
      );
      expect(email).toBe("emails-viewer@example.test");
    });

    it("is visible to an admin of a shared workspace", async () => {
      const email = await withTenant(db, need(ids, "admin"), (tx) =>
        visibleUserEmail(tx, need(ids, "operator")),
      );
      expect(email).toBe("emails-operator@example.test");
    });

    it("is hidden from a fellow member below admin", async () => {
      const email = await withTenant(db, need(ids, "viewer"), (tx) =>
        visibleUserEmail(tx, need(ids, "operator")),
      );
      expect(email).toBeNull();
    });

    it("is hidden from an admin who shares no workspace", async () => {
      const email = await withTenant(db, need(ids, "admin"), (tx) =>
        visibleUserEmail(tx, strangerId),
      );
      expect(email).toBeNull();
    });
  });
});
