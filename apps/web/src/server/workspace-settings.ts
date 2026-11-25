import {
  mcpConnectors,
  type StoredPreapproval,
  type TenantTx,
  withTenant,
  workspaceSettings,
} from "@delegate/db";
import {
  connectorToolName,
  PREAPPROVABLE_TOOL_PREFIX,
  ScreenedToolSchema,
  toolDefinitionSha256,
  type ToolPreapproval,
} from "@delegate/runtime/server";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { AppDatabase } from "./db";
import type { GuestSession } from "./session";

export const MAX_PREAPPROVED_TOOLS = 50;

export interface WorkspaceAutomation {
  autoApprovePlans: boolean;
  preapprovedTools: string[];
  changedTools: string[];
}

export const DEFAULT_AUTOMATION: WorkspaceAutomation = {
  autoApprovePlans: false,
  preapprovedTools: [],
  changedTools: [],
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

export class AutomationError extends Error {
  override readonly name = "AutomationError";
}

const storedPreapprovalSchema = z.object({
  tool: toolName,
  connectorId: z.uuid(),
  definitionSha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export function parseStoredPreapprovals(value: unknown): StoredPreapproval[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = storedPreapprovalSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

const storedTools = z.array(ScreenedToolSchema).catch([]);

async function currentBindings(
  tx: TenantTx,
  workspaceId: string,
): Promise<Map<string, ToolPreapproval>> {
  const rows = await tx
    .select({ id: mcpConnectors.id, name: mcpConnectors.name, tools: mcpConnectors.tools })
    .from(mcpConnectors)
    .where(eq(mcpConnectors.workspaceId, workspaceId));
  const bindings = new Map<string, ToolPreapproval>();
  for (const row of rows)
    for (const tool of storedTools.parse(row.tools)) {
      if (tool.readOnly || tool.withheld) continue;
      const name = connectorToolName(row.name, tool.name);
      bindings.set(name, {
        tool: name,
        connectorId: row.id,
        definitionSha256: toolDefinitionSha256(tool),
      });
    }
  return bindings;
}

interface AutomationState {
  autoApprovePlans: boolean;
  valid: ToolPreapproval[];
  changed: StoredPreapproval[];
}

async function readState(tx: TenantTx, workspaceId: string): Promise<AutomationState> {
  const [row] = await tx
    .select({
      autoApprovePlans: workspaceSettings.autoApprovePlans,
      preapprovedTools: workspaceSettings.preapprovedTools,
    })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId));
  if (row === undefined) return { autoApprovePlans: false, valid: [], changed: [] };
  const bindings = await currentBindings(tx, workspaceId);
  const valid: ToolPreapproval[] = [];
  const changed: StoredPreapproval[] = [];
  for (const entry of parseStoredPreapprovals(row.preapprovedTools)) {
    const current = bindings.get(entry.tool);
    if (
      current?.connectorId === entry.connectorId &&
      current.definitionSha256 === entry.definitionSha256
    )
      valid.push(entry);
    else changed.push(entry);
  }
  return { autoApprovePlans: row.autoApprovePlans, valid, changed };
}

function view(state: AutomationState): WorkspaceAutomation {
  return {
    autoApprovePlans: state.autoApprovePlans,
    preapprovedTools: state.valid.map((entry) => entry.tool),
    changedTools: state.changed.map((entry) => entry.tool),
  };
}

export async function readAutomation(
  app: AppDatabase,
  session: GuestSession,
): Promise<WorkspaceAutomation> {
  return view(await withTenant(app.db, session.userId, (tx) => readState(tx, session.workspaceId)));
}

export async function readPreapprovals(
  app: AppDatabase,
  session: GuestSession,
): Promise<ToolPreapproval[]> {
  return (await withTenant(app.db, session.userId, (tx) => readState(tx, session.workspaceId)))
    .valid;
}

export async function updateAutomation(
  app: AppDatabase,
  session: GuestSession,
  update: AutomationUpdate,
): Promise<WorkspaceAutomation> {
  return withTenant(app.db, session.userId, async (tx) => {
    const current = await readState(tx, session.workspaceId);
    let preapprovals: StoredPreapproval[] = [...current.valid, ...current.changed];
    if (update.preapprovedTools !== undefined) {
      const bindings = await currentBindings(tx, session.workspaceId);
      preapprovals = [...new Set(update.preapprovedTools)].map((name) => {
        const binding = bindings.get(name);
        if (binding === undefined)
          throw new AutomationError(
            `${name} is not a side-effecting tool on a connector in this workspace`,
          );
        return binding;
      });
    }
    const autoApprovePlans = update.autoApprovePlans ?? current.autoApprovePlans;
    await tx
      .insert(workspaceSettings)
      .values({
        workspaceId: session.workspaceId,
        autoApprovePlans,
        preapprovedTools: preapprovals,
      })
      .onConflictDoUpdate({
        target: workspaceSettings.workspaceId,
        set: { autoApprovePlans, preapprovedTools: preapprovals, updatedAt: sql`now()` },
      });
    return view(await readState(tx, session.workspaceId));
  });
}

export async function forgetConnectorPreapprovals(
  tx: TenantTx,
  workspaceId: string,
  connectorId: string,
): Promise<void> {
  const [row] = await tx
    .select({ preapprovedTools: workspaceSettings.preapprovedTools })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId));
  if (row === undefined) return;
  const kept = parseStoredPreapprovals(row.preapprovedTools).filter(
    (entry) => entry.connectorId !== connectorId,
  );
  await tx
    .update(workspaceSettings)
    .set({ preapprovedTools: kept, updatedAt: sql`now()` })
    .where(eq(workspaceSettings.workspaceId, workspaceId));
}
