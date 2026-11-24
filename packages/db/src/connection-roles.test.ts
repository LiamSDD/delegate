import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { withTenant } from "./client";
import { runs } from "./schema";
import { seedMember, seedUser, seedWorkspaceContent } from "./testing/fixtures";
import {
  APP_LOGIN_ROLE,
  asAppLogin,
  createTestDb,
  expectDatabaseError,
  rowsOf,
  type TestDb,
} from "./testing/pglite";

describe("app login role", () => {
  let harness: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let alice: string;
  let mine: Awaited<ReturnType<typeof seedWorkspaceContent>>;
  let theirs: Awaited<ReturnType<typeof seedWorkspaceContent>>;

  beforeAll(async () => {
    harness = await createTestDb();
    db = harness.db;
    alice = (await seedUser(db, "alice")).id;
    const bob = (await seedUser(db, "bob")).id;
    mine = await seedWorkspaceContent(db, "mine", alice);
    theirs = await seedWorkspaceContent(db, "theirs", bob);
    await seedMember(db, mine.workspace.id, alice, "owner");
    await seedMember(db, theirs.workspace.id, bob, "owner");
  });

  afterAll(async () => {
    await harness.client.close();
  });

  it("can log in, has no inherited privileges, cannot bypass RLS and is only a member of delegate_app", async () => {
    const [role] = await rowsOf(
      z.object({
        rolcanlogin: z.boolean(),
        rolinherit: z.boolean(),
        rolbypassrls: z.boolean(),
        rolsuper: z.boolean(),
        rolcreaterole: z.boolean(),
        member_of: z.array(z.string()),
      }),
      db.execute(sql`
        select r.rolcanlogin, r.rolinherit, r.rolbypassrls, r.rolsuper, r.rolcreaterole,
          coalesce(array(
            select g.rolname::text from pg_auth_members m join pg_roles g on g.oid = m.roleid
            where m.member = r.oid order by 1
          ), '{}') as member_of
        from pg_roles r where r.rolname = ${APP_LOGIN_ROLE}`),
    );
    expect(role).toEqual({
      rolcanlogin: true,
      rolinherit: false,
      rolbypassrls: false,
      rolsuper: false,
      rolcreaterole: false,
      member_of: ["delegate_app"],
    });
  });

  it("owns no relations or functions", async () => {
    const [owned] = await rowsOf(
      z.object({ n: z.coerce.number() }),
      db.execute(sql`
        select (select count(*) from pg_class where relowner = ${APP_LOGIN_ROLE}::regrole)
             + (select count(*) from pg_proc where proowner = ${APP_LOGIN_ROLE}::regrole) as n`),
    );
    expect(owned?.n).toBe(0);
  });

  it("forces row-level security on every table in the public schema", async () => {
    const tables = await rowsOf(
      z.object({
        relname: z.string(),
        relrowsecurity: z.boolean(),
        relforcerowsecurity: z.boolean(),
      }),
      db.execute(sql`
        select c.relname::text, c.relrowsecurity, c.relforcerowsecurity
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' order by 1`),
    );
    expect(tables.length).toBeGreaterThan(10);
    for (const table of tables) {
      expect(table, table.relname).toMatchObject({
        relrowsecurity: true,
        relforcerowsecurity: true,
      });
    }
  });

  it("lets a non-superuser table owner see nothing, because RLS is forced", async () => {
    const ownerView = await db.transaction(async (tx) => {
      await tx.execute(sql`create role probe_owner nologin`);
      await tx.execute(sql`alter table runs owner to probe_owner`);
      await tx.execute(sql`set local role probe_owner`);
      const rows = await rowsOf(
        z.object({ n: z.coerce.number() }),
        tx.execute(sql`select count(*) as n from runs`),
      );
      await tx.execute(sql`reset role`);
      await tx.execute(sql`alter table runs owner to postgres`);
      await tx.execute(sql`drop role probe_owner`);
      return rows[0]?.n;
    });
    expect(ownerView).toBe(0);
  });

  it("has no table privileges of its own outside withTenant", async () => {
    await expectDatabaseError(
      asAppLogin(db, () => db.select({ id: runs.id }).from(runs)),
      /permission denied for table runs/,
    );
  });

  it("runs withTenant as delegate_app on top of the login session", async () => {
    const identity = await asAppLogin(db, () =>
      withTenant(db, alice, (tx) =>
        rowsOf(
          z.object({ current_user: z.string(), session_user: z.string() }),
          tx.execute(sql`select current_user, session_user`),
        ),
      ),
    );
    expect(identity).toEqual([{ current_user: "delegate_app", session_user: APP_LOGIN_ROLE }]);
    const visible = await asAppLogin(db, () =>
      withTenant(db, alice, (tx) => tx.select({ id: runs.id }).from(runs)),
    );
    expect(visible.map((row) => row.id)).toEqual([mine.run.id]);
  });

  it("cannot escape RLS with RESET ROLE inside withTenant", async () => {
    await expectDatabaseError(
      asAppLogin(db, () =>
        withTenant(db, alice, async (tx) => {
          await tx.execute(sql`reset role`);
          return tx
            .select({ id: runs.id })
            .from(runs)
            .where(eq(runs.workspaceId, theirs.workspace.id));
        }),
      ),
      /permission denied for table runs/,
    );
  });

  it("cannot switch to a privileged role", async () => {
    for (const role of [
      "postgres",
      "delegate_definer",
      "delegate_system",
      "delegate_maintenance",
    ]) {
      await expectDatabaseError(
        asAppLogin(db, () =>
          withTenant(db, alice, (tx) => tx.execute(sql`set local role ${sql.identifier(role)}`)),
        ),
        /permission denied to set role/,
      );
    }
  });

  it("cannot disable the append-only triggers", async () => {
    await expectDatabaseError(
      asAppLogin(db, () =>
        withTenant(db, alice, (tx) => tx.execute(sql`alter table run_events disable trigger all`)),
      ),
      /must be owner of table run_events/,
    );
  });
});
