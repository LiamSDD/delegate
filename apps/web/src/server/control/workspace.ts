import {
  githubInstallations,
  mcpConnectors,
  members,
  withTenant,
  workspaceSettings,
  workspaces,
} from "@delegate/db";
import type { AutopilotTier } from "@delegate/runtime";
import { and, count, eq } from "drizzle-orm";

import type { AppDatabase } from "../db";
import type { GuestSession } from "../session";

export interface WorkspaceOverview {
  id: string;
  name: string;
  tier: AutopilotTier;
  demo: boolean;
  role: string | null;
  createdAt: Date;
  retentionDays: number | null;
  runsPausedAt: Date | null;
  connectors: number;
  githubInstallations: number;
}

export async function workspaceOverview(
  app: AppDatabase,
  session: GuestSession,
): Promise<WorkspaceOverview | null> {
  return withTenant(app.db, session.userId, async (tx) => {
    const [workspace] = await tx
      .select({
        id: workspaces.id,
        name: workspaces.name,
        demo: workspaces.isDemo,
        createdAt: workspaces.createdAt,
        retentionDays: workspaces.retentionDays,
        role: members.role,
        runsPausedAt: workspaceSettings.runsPausedAt,
      })
      .from(workspaces)
      .leftJoin(
        members,
        and(eq(members.workspaceId, workspaces.id), eq(members.userId, session.userId)),
      )
      .leftJoin(workspaceSettings, eq(workspaceSettings.workspaceId, workspaces.id))
      .where(eq(workspaces.id, session.workspaceId));
    if (workspace === undefined) return null;
    const [connectors] = await tx
      .select({ total: count() })
      .from(mcpConnectors)
      .where(eq(mcpConnectors.workspaceId, session.workspaceId));
    const [installations] = await tx
      .select({ total: count() })
      .from(githubInstallations)
      .where(eq(githubInstallations.workspaceId, session.workspaceId));
    const connectorCount = connectors?.total ?? 0;
    const installationCount = installations?.total ?? 0;
    return {
      ...workspace,
      tier: connectorCount + installationCount > 0 ? "connected" : "guest",
      connectors: connectorCount,
      githubInstallations: installationCount,
    };
  });
}
