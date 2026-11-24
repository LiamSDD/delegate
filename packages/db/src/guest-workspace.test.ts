import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createGuestWorkspace, withTenant } from "./client";
import { members, users, workspaces } from "./schema";
import {
  asAppLogin,
  createTestDb,
  expectDatabaseError,
  rowsOf,
  type TestDb,
} from "./testing/pglite";
import { z } from "zod";

describe("create_guest_workspace()", () => {
  let harness: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;

  beforeAll(async () => {
    harness = await createTestDb();
    db = harness.db;
  });

  afterAll(async () => {
    await harness.client.close();
  });

  it("creates a guest user, org, demo workspace and owner membership for the app login", async () => {
    const guest = await asAppLogin(db, () => createGuestWorkspace(db));
    const seen = await asAppLogin(db, () =>
      withTenant(db, guest.userId, async (tx) => ({
        user: await tx
          .select({ kind: users.kind, displayName: users.displayName })
          .from(users)
          .where(eq(users.id, guest.userId)),
        workspace: await tx
          .select({
            isDemo: workspaces.isDemo,
            retentionDays: workspaces.retentionDays,
            slug: workspaces.slug,
          })
          .from(workspaces)
          .where(eq(workspaces.id, guest.workspaceId)),
        membership: await tx
          .select({ role: members.role })
          .from(members)
          .where(eq(members.workspaceId, guest.workspaceId)),
      })),
    );
    expect(seen.user).toEqual([{ kind: "guest", displayName: "Guest" }]);
    expect(seen.workspace).toEqual([{ isDemo: true, retentionDays: 7, slug: "demo" }]);
    expect(seen.membership).toEqual([{ role: "owner" }]);
  });

  it("gives every guest a separate org that other guests cannot see", async () => {
    const first = await asAppLogin(db, () => createGuestWorkspace(db));
    const second = await asAppLogin(db, () => createGuestWorkspace(db));
    expect(second.workspaceId).not.toBe(first.workspaceId);
    const visible = await asAppLogin(db, () =>
      withTenant(db, second.userId, (tx) =>
        tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.id, first.workspaceId)),
      ),
    );
    expect(visible).toEqual([]);
  });

  it("does not let the app role insert tenancy rows directly", async () => {
    await asAppLogin(db, () =>
      expectDatabaseError(
        db.transaction(async (tx) => {
          await tx.execute(sql`set local role delegate_app`);
          await tx.insert(users).values({ displayName: "Forged", kind: "member" });
        }),
        /permission denied|row-level security/,
      ),
    );
  });

  it("is not callable by PUBLIC, only by the app role", async () => {
    const grants = await rowsOf(
      z.object({ grantee: z.string() }),
      db.execute(
        sql`select grantee::text from information_schema.routine_privileges
            where routine_name = 'create_guest_workspace' and privilege_type = 'EXECUTE'
            order by grantee`,
      ),
    );
    expect(grants.map((row) => row.grantee)).toEqual(["delegate_app", "delegate_definer"]);
  });
});
