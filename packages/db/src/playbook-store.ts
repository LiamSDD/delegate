import {
  PlaybookSchema,
  foldLessons,
  type Playbook,
  type PlaybookStore,
  type RunLessons,
} from "@delegate/runtime";
import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { type Database, type TenantTx, withTenant } from "./client";
import { type TenantScope } from "./knowledge-store";
import { playbooks } from "./schema";

export interface PlaybookVersionRow {
  scope: "workspace" | "house";
  key: string;
  version: number;
  runs: number;
  createdAt: string;
  playbook: Playbook;
}

function parsed(content: unknown): Playbook | null {
  const result = PlaybookSchema.safeParse(content);
  return result.success ? result.data : null;
}

async function latest(
  tx: TenantTx,
  key: string,
  workspaceId: string | null,
): Promise<Playbook | null> {
  const [row] = await tx
    .select({ content: playbooks.content })
    .from(playbooks)
    .where(
      and(
        eq(playbooks.key, key),
        workspaceId === null
          ? isNull(playbooks.workspaceId)
          : eq(playbooks.workspaceId, workspaceId),
      ),
    )
    .orderBy(desc(playbooks.version))
    .limit(1);
  return row === undefined ? null : parsed(row.content);
}

export function createDbPlaybookStore(db: Database, scope: TenantScope): PlaybookStore {
  return {
    read: (key) =>
      withTenant(db, scope.userId, async (tx) => ({
        workspace: await latest(tx, key, scope.workspaceId),
        house: await latest(tx, key, null),
      })),
    record: async (run: RunLessons, options) => {
      await withTenant(db, scope.userId, async (tx) => {
        const current = await latest(tx, run.key, scope.workspaceId);
        const next = foldLessons(current, run, "workspace");
        if (next === current) return;
        await tx.insert(playbooks).values({
          workspaceId: scope.workspaceId,
          scope: "workspace",
          key: next.key,
          version: next.version,
          runs: next.runs,
          content: next,
        });
      });
      if (!options.house) return;
      await recordHousePlaybook(db, scope, run);
    },
  };
}

export async function recordHousePlaybook(
  db: Database,
  scope: TenantScope,
  run: RunLessons,
): Promise<Playbook | null> {
  return withTenant(db, scope.userId, async (tx) => {
    const current = await latest(tx, run.key, null);
    const next = foldLessons(current, run, "house");
    if (next === current) return current;
    await tx.execute(
      sql`select record_house_playbook(${scope.workspaceId}::uuid, ${next.key}, ${next.version}, ${next.runs}, ${JSON.stringify(next)}::jsonb)`,
    );
    return next;
  });
}

export async function listPlaybookVersions(
  db: Database,
  scope: TenantScope,
  options: { limit?: number } = {},
): Promise<PlaybookVersionRow[]> {
  return withTenant(db, scope.userId, async (tx) => {
    const rows = await tx
      .select({
        workspaceId: playbooks.workspaceId,
        content: playbooks.content,
        createdAt: playbooks.createdAt,
      })
      .from(playbooks)
      .where(
        sql`${playbooks.workspaceId} is null or ${playbooks.workspaceId} = ${scope.workspaceId}`,
      )
      .orderBy(desc(playbooks.createdAt), desc(playbooks.version))
      .limit(options.limit ?? 200);
    return rows.flatMap((row) => {
      const playbook = parsed(row.content);
      if (playbook === null) return [];
      return [
        {
          scope: row.workspaceId === null ? ("house" as const) : ("workspace" as const),
          key: playbook.key,
          version: playbook.version,
          runs: playbook.runs,
          createdAt: row.createdAt.toISOString(),
          playbook,
        },
      ];
    });
  });
}
