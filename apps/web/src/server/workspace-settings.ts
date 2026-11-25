import { PREAPPROVABLE_TOOL_PREFIX } from "@delegate/runtime/server";
import { withTenant, workspaceSettings } from "@delegate/db";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { AppDatabase } from "./db";
import type { GuestSession } from "./session";

export const MAX_PREAPPROVED_TOOLS = 50;

export interface WorkspaceAutomation {
  autoApprovePlans: boolean;
  preapprovedTools: string[];
}

export const DEFAULT_AUTOMATION: WorkspaceAutomation = {
  autoApprovePlans: false,
  preapprovedTools: [],
};

const toolName = z
  .string()
  .regex(/^mcp__[a-z0-9][a-z0-9-]{0,31}__[A-Za-z0-9_-]{1,64}$/)
  .refine((name) => name.startsWith(PREAPPROVABLE_TOOL_PREFIX));

export const AutomationUpdateSchema = z.strictObject({
  autoApprovePlans: z.boolean().optional(),
  preapprovedTools: z.array(toolName).max(MAX_PREAPPROVED_TOOLS).optional(),
});
export type AutomationUpdate = z.infer<typeof AutomationUpdateSchema>;

const storedTools = z.array(z.string()).catch([]);

export async function readAutomation(
  app: AppDatabase,
  session: GuestSession,
): Promise<WorkspaceAutomation> {
  const [row] = await withTenant(app.db, session.userId, (tx) =>
    tx
      .select({
        autoApprovePlans: workspaceSettings.autoApprovePlans,
        preapprovedTools: workspaceSettings.preapprovedTools,
      })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, session.workspaceId)),
  );
  if (row === undefined) return { ...DEFAULT_AUTOMATION };
  return {
    autoApprovePlans: row.autoApprovePlans,
    preapprovedTools: storedTools
      .parse(row.preapprovedTools)
      .filter((name) => name.startsWith(PREAPPROVABLE_TOOL_PREFIX)),
  };
}

export async function updateAutomation(
  app: AppDatabase,
  session: GuestSession,
  update: AutomationUpdate,
): Promise<WorkspaceAutomation> {
  const current = await readAutomation(app, session);
  const next: WorkspaceAutomation = {
    autoApprovePlans: update.autoApprovePlans ?? current.autoApprovePlans,
    preapprovedTools: [...new Set(update.preapprovedTools ?? current.preapprovedTools)],
  };
  await withTenant(app.db, session.userId, (tx) =>
    tx
      .insert(workspaceSettings)
      .values({ workspaceId: session.workspaceId, ...next })
      .onConflictDoUpdate({
        target: workspaceSettings.workspaceId,
        set: { ...next, updatedAt: sql`now()` },
      }),
  );
  return next;
}
