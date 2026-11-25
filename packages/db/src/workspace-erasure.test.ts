import { count, eq, isNull, sql } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { withTenant } from "./client";
import {
  apiTokens,
  approvals,
  artifacts,
  assistants,
  auditLog,
  chunks,
  documents,
  githubInstallations,
  mcpConnectors,
  members,
  memories,
  orgs,
  playbooks,
  policies,
  runEvents,
  runs,
  users,
  workspaceSettings,
  workspaces,
} from "./schema";
import { seedMember, seedUser, seedWorkspaceContent } from "./testing/fixtures";
import {
  asAppLogin,
  createTestDb,
  expectDatabaseError,
  rowsOf,
  type TestDb,
} from "./testing/pglite";

const ERASED_DIRECTLY = [
  "audit_log",
  "runs",
  "assistants",
  "documents",
  "memories",
  "playbooks",
  "policies",
  "mcp_connectors",
  "github_installations",
  "api_tokens",
  "workspace_settings",
] as const;

const ERASED_BY_CASCADE = ["run_events", "artifacts", "approvals", "chunks"] as const;

const KEPT = ["members"] as const;

const receiptSchema = z.object({
  receipt: z.number().int().positive(),
  counts: z.record(z.string(), z.number().int().nonnegative()),
});

const WORKSPACE_TABLES: [string, PgTable, AnyPgColumn][] = [
  ["runs", runs, runs.workspaceId],
  ["run_events", runEvents, runEvents.workspaceId],
  ["artifacts", artifacts, artifacts.workspaceId],
  ["approvals", approvals, approvals.workspaceId],
  ["assistants", assistants, assistants.workspaceId],
  ["documents", documents, documents.workspaceId],
  ["chunks", chunks, chunks.workspaceId],
  ["memories", memories, memories.workspaceId],
  ["playbooks", playbooks, playbooks.workspaceId],
  ["policies", policies, policies.workspaceId],
  ["mcp_connectors", mcpConnectors, mcpConnectors.workspaceId],
  ["github_installations", githubInstallations, githubInstallations.workspaceId],
  ["api_tokens", apiTokens, apiTokens.workspaceId],
  ["workspace_settings", workspaceSettings, workspaceSettings.workspaceId],
  ["audit_log", auditLog, auditLog.workspaceId],
  ["members", members, members.workspaceId],
];

describe("delete_workspace_data", () => {
  let harness: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  const ids = { ownerA: "", adminA: "", operatorA: "", viewerA: "", ownerB: "", outsider: "" };
  let agentId = "";
  let a: Awaited<ReturnType<typeof seedWorkspaceContent>>;
  let b: Awaited<ReturnType<typeof seedWorkspaceContent>>;
  let agentWorkspace: Awaited<ReturnType<typeof seedWorkspaceContent>>;

  async function fill(workspaceId: string, runId: string, userId: string, label: string) {
    const [child] = await db
      .insert(runs)
      .values({
        workspaceId,
        mission: "xray",
        input: { label },
        createdBy: userId,
        parentRunId: runId,
      })
      .returning({ id: runs.id });
    if (!child) throw new Error("child run not created");
    await db
      .insert(runEvents)
      .values({ runId: child.id, workspaceId, seq: 1, type: "run.created" });
    await db.insert(memories).values({
      workspaceId,
      runId,
      key: "run-fact",
      value: { label },
      createdByAgent: "researcher",
    });
    await db.insert(assistants).values([
      {
        workspaceId,
        runId,
        name: `Run assistant ${label}`,
        collection: `run-${label}`,
        config: {},
      },
      { workspaceId, name: `Loose assistant ${label}`, collection: `loose-${label}`, config: {} },
    ]);
    await db.insert(mcpConnectors).values({
      workspaceId,
      createdBy: userId,
      name: `tickets-${label}`,
      url: `https://mcp.${label}.example/mcp`,
    });
    await db.insert(githubInstallations).values({
      workspaceId,
      installationId: label === "a" ? 101 : 202,
      accountLogin: `acme-${label}`,
      accountType: "Organization",
      repositorySelection: "all",
    });
    await db.insert(apiTokens).values({
      workspaceId,
      createdBy: userId,
      name: `token ${label}`,
      prefix: `dlg_${label.repeat(8)}`,
      tokenHash: (label === "a" ? "a" : "b").repeat(64),
    });
    await db
      .insert(workspaceSettings)
      .values({ workspaceId, autoApprovePlans: true, runsPausedAt: new Date() });
    await db.insert(playbooks).values({
      workspaceId,
      scope: "workspace",
      key: "company-xray:default",
      version: 1,
      content: { label },
    });
  }

  async function tally(workspaceId: string): Promise<Record<string, number>> {
    const totals: Record<string, number> = {};
    for (const [name, table, column] of WORKSPACE_TABLES) {
      const [row] = await db.select({ n: count() }).from(table).where(eq(column, workspaceId));
      totals[name] = row?.n ?? 0;
    }
    return totals;
  }

  function erase(userId: string, workspaceId: string) {
    return asAppLogin(db, () =>
      withTenant(db, userId, async (tx) => {
        const [row] = await rowsOf(
          z.object({ result: receiptSchema }),
          tx.execute(sql`select delete_workspace_data(${workspaceId}::uuid) as result`),
        );
        if (!row) throw new Error("delete_workspace_data returned no row");
        return row.result;
      }),
    );
  }

  beforeAll(async () => {
    harness = await createTestDb();
    db = harness.db;
    for (const name of Object.keys(ids) as (keyof typeof ids)[])
      ids[name] = (await seedUser(db, name)).id;
    a = await seedWorkspaceContent(db, "a", ids.ownerA);
    b = await seedWorkspaceContent(db, "b", ids.ownerB);
    await seedMember(db, a.workspace.id, ids.ownerA, "owner");
    await seedMember(db, a.workspace.id, ids.adminA, "admin");
    await seedMember(db, a.workspace.id, ids.operatorA, "operator");
    await seedMember(db, a.workspace.id, ids.viewerA, "viewer");
    await seedMember(db, b.workspace.id, ids.ownerB, "owner");
    await fill(a.workspace.id, a.run.id, ids.ownerA, "a");
    await fill(b.workspace.id, b.run.id, ids.ownerB, "b");
    await db.insert(playbooks).values({
      workspaceId: null,
      scope: "house",
      key: "company-xray:default",
      version: 1,
      content: { scope: "house" },
    });
    const [agent] = await db
      .insert(users)
      .values({ displayName: "Agent", kind: "agent" })
      .returning({ id: users.id });
    if (!agent) throw new Error("agent not created");
    agentId = agent.id;
    agentWorkspace = await seedWorkspaceContent(db, "agent", ids.outsider);
    await seedMember(db, agentWorkspace.workspace.id, agentId, "owner");
  });

  afterAll(async () => {
    await harness.client.close();
  });

  it("covers every table that carries a workspace id", async () => {
    const tables = (
      await rowsOf(
        z.object({ table_name: z.string() }),
        db.execute(
          sql`select c.table_name from information_schema.columns c
              join information_schema.tables t
                on t.table_schema = c.table_schema and t.table_name = c.table_name
              where c.table_schema = 'public' and c.column_name = 'workspace_id'
                and t.table_type = 'BASE TABLE'
              order by c.table_name`,
        ),
      )
    ).map((row) => row.table_name);
    const handled = new Set<string>([...ERASED_DIRECTLY, ...ERASED_BY_CASCADE, ...KEPT]);
    expect(
      tables.filter((table) => !handled.has(table)),
      "these tables hold workspace data that delete_workspace_data() neither deletes nor is told to keep: extend the function in a new migration, or list the table as kept with a reason",
    ).toEqual([]);
    expect(WORKSPACE_TABLES.map(([name]) => name).sort()).toEqual([...handled].sort());

    const [definition] = await rowsOf(
      z.object({ body: z.string() }),
      db.execute(
        sql`select pg_get_functiondef('public.delete_workspace_data(uuid)'::regprocedure) as body`,
      ),
    );
    for (const table of ERASED_DIRECTLY)
      expect(definition?.body, table).toMatch(
        new RegExp(
          `DELETE FROM public\\.${table} \\w+\\s+WHERE \\w+\\.workspace_id = p_workspace_id`,
        ),
      );

    const cascades = await rowsOf(
      z.object({ child: z.string(), parent: z.string() }),
      db.execute(
        sql`select child.relname as child, parent.relname as parent
            from pg_constraint fk
            join pg_class child on child.oid = fk.conrelid
            join pg_class parent on parent.oid = fk.confrelid
            where fk.contype = 'f' and fk.confdeltype = 'c'`,
      ),
    );
    for (const table of ERASED_BY_CASCADE)
      expect(
        cascades.some(
          (fk) =>
            fk.child === table &&
            (ERASED_DIRECTLY as readonly string[]).includes(fk.parent) &&
            fk.parent !== "audit_log",
        ),
        `${table} must cascade from a table the function deletes`,
      ).toBe(true);
  });

  it("is not executable outside the app role", async () => {
    await expectDatabaseError(
      asAppLogin(db, () => db.execute(sql`select delete_workspace_data(${a.workspace.id}::uuid)`)),
      /permission denied for function delete_workspace_data/,
    );
  });

  it("hides workspaces the caller does not belong to and changes nothing", async () => {
    const before = await tally(b.workspace.id);
    await expectDatabaseError(erase(ids.outsider, b.workspace.id), /workspace not found/);
    await expectDatabaseError(erase(ids.ownerA, b.workspace.id), /workspace not found/);
    expect(await tally(b.workspace.id)).toEqual(before);
  });

  it("requires the owner: admins, operators and viewers are refused", async () => {
    const before = await tally(a.workspace.id);
    for (const user of [ids.adminA, ids.operatorA, ids.viewerA])
      await expectDatabaseError(erase(user, a.workspace.id), /requires the workspace owner/);
    expect(await tally(a.workspace.id)).toEqual(before);
  });

  it("refuses an agent identity even when it owns the workspace", async () => {
    const before = await tally(agentWorkspace.workspace.id);
    await expectDatabaseError(
      erase(agentId, agentWorkspace.workspace.id),
      /agents cannot delete workspace data/,
    );
    expect(await tally(agentWorkspace.workspace.id)).toEqual(before);
  });

  it("does not open the append-only guard for a session that sets the flag itself", async () => {
    await expectDatabaseError(
      db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('delegate.workspace_erasure', 'on', true)`);
        await tx.execute(sql`delete from run_events where run_id = ${a.run.id}`);
      }),
      /run_events is append-only: DELETE is not allowed/,
    );
    await expectDatabaseError(
      db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('delegate.workspace_erasure', 'on', true)`);
        await tx.execute(sql`delete from audit_log where workspace_id = ${a.workspace.id}`);
      }),
      /audit_log is append-only: DELETE is not allowed/,
    );
  });

  it("deletes one workspace's data and leaves every other workspace untouched", async () => {
    const otherBefore = await tally(b.workspace.id);
    const agentBefore = await tally(agentWorkspace.workspace.id);
    const before = await tally(a.workspace.id);
    expect(before).toMatchObject({
      runs: 2,
      run_events: 2,
      artifacts: 1,
      approvals: 1,
      assistants: 2,
      documents: 1,
      chunks: 1,
      memories: 2,
      playbooks: 1,
      policies: 1,
      mcp_connectors: 1,
      github_installations: 1,
      api_tokens: 1,
      workspace_settings: 1,
      audit_log: 1,
      members: 4,
    });

    const result = await erase(ids.ownerA, a.workspace.id);
    expect(result.counts).toEqual({
      runs: 2,
      events: 2,
      artifacts: 1,
      approvals: 1,
      assistants: 2,
      documents: 1,
      memories: 2,
      playbooks: 1,
      policies: 1,
      connectors: 1,
      githubInstallations: 1,
      apiTokens: 1,
      settings: 1,
      auditEntries: 1,
    });

    const after = await tally(a.workspace.id);
    for (const table of [...ERASED_DIRECTLY, ...ERASED_BY_CASCADE])
      expect(after[table], table).toBe(table === "audit_log" ? 1 : 0);
    expect(after.members).toBe(4);

    const [workspace] = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, a.workspace.id));
    expect(workspace?.id).toBe(a.workspace.id);
    const [org] = await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, a.org.id));
    expect(org?.id).toBe(a.org.id);

    const receipts = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.workspaceId, a.workspace.id));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      id: result.receipt,
      action: "workspace.data_deleted",
      actorType: "user",
      actorId: ids.ownerA,
      target: `workspace:${a.workspace.id}`,
      details: { counts: result.counts },
    });

    expect(await tally(b.workspace.id)).toEqual(otherBefore);
    expect(await tally(agentWorkspace.workspace.id)).toEqual(agentBefore);
    const house = await db
      .select({ id: playbooks.id })
      .from(playbooks)
      .where(isNull(playbooks.workspaceId));
    expect(house).toHaveLength(1);
  });

  it("keeps each deletion's receipt when it runs again on an empty workspace", async () => {
    const again = await erase(ids.ownerA, a.workspace.id);
    expect(Object.values(again.counts).every((value) => value === 0)).toBe(true);
    const receipts = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.workspaceId, a.workspace.id));
    expect(receipts).toHaveLength(2);
  });

  it("leaves the append-only guard armed after it returns", async () => {
    await expectDatabaseError(
      db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.user_id', ${ids.ownerA}, true)`);
        await tx.execute(sql`select delete_workspace_data(${a.workspace.id}::uuid)`);
        await tx.execute(sql`delete from run_events where run_id = ${b.run.id}`);
      }),
      /run_events is append-only: DELETE is not allowed/,
    );
    await expectDatabaseError(
      db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.user_id', ${ids.ownerA}, true)`);
        await tx.execute(sql`select delete_workspace_data(${a.workspace.id}::uuid)`);
        await tx.execute(sql`delete from audit_log where workspace_id = ${b.workspace.id}`);
      }),
      /audit_log is append-only: DELETE is not allowed/,
    );
  });
});
