import { withTenant } from "@delegate/db";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { ASSISTANT_KIND } from "@/lib/m3-contract";

import type { AppDatabase } from "../db";
import type { GuestSession } from "../session";

const whole = z.coerce.number().int().nonnegative();

const inventoryRow = z.object({
  runs: whole,
  events: whole,
  artifacts: whole,
  assistants: whole,
  connectors: whole,
  github_installations: whole,
  api_tokens: whole,
  settings: whole,
});

export interface DataInventory {
  runs: number;
  events: number;
  artifacts: number;
  assistants: number;
  connectors: number;
  githubInstallations: number;
  apiTokens: number;
  settings: number;
}

export const EMPTY_INVENTORY: DataInventory = {
  runs: 0,
  events: 0,
  artifacts: 0,
  assistants: 0,
  connectors: 0,
  githubInstallations: 0,
  apiTokens: 0,
  settings: 0,
};

export function isEmptyInventory(inventory: DataInventory): boolean {
  return Object.values(inventory).every((value) => value === 0);
}

export async function dataInventory(
  app: AppDatabase,
  session: GuestSession,
): Promise<DataInventory> {
  const workspace = session.workspaceId;
  const result = await withTenant(app.db, session.userId, (tx) =>
    tx.execute(sql`
      select
        (select count(*) from runs where workspace_id = ${workspace}::uuid) as runs,
        (select count(*) from run_events where workspace_id = ${workspace}::uuid) as events,
        (select count(*) from artifacts where workspace_id = ${workspace}::uuid) as artifacts,
        (select count(*) from artifacts
          where workspace_id = ${workspace}::uuid and kind = ${ASSISTANT_KIND}) as assistants,
        (select count(*) from mcp_connectors where workspace_id = ${workspace}::uuid) as connectors,
        (select count(*) from github_installations
          where workspace_id = ${workspace}::uuid) as github_installations,
        (select count(*) from api_tokens where workspace_id = ${workspace}::uuid) as api_tokens,
        (select count(*) from workspace_settings where workspace_id = ${workspace}::uuid) as settings
    `),
  );
  const row = inventoryRow.parse(z.object({ rows: z.array(z.unknown()) }).parse(result).rows[0]);
  return {
    runs: row.runs,
    events: row.events,
    artifacts: row.artifacts,
    assistants: row.assistants,
    connectors: row.connectors,
    githubInstallations: row.github_installations,
    apiTokens: row.api_tokens,
    settings: row.settings,
  };
}
