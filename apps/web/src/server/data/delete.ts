import { artifacts, withTenant } from "@delegate/db";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { ASSISTANT_KIND } from "@/lib/m3-contract";
import { AUTO_APPROVE_COOKIE, MISSION_PREF_COOKIE } from "@/lib/runs/preferences";

import { type ApiDeps, apiError, NO_STORE, readJson } from "../api";
import { assistantStores } from "../assistants";
import { issuesOf, operatorFor, postgresCode } from "../control/http";
import { stopAllRuns } from "../control/switches";
import type { AppDatabase } from "../db";
import { type GuestSession, SESSION_COOKIE } from "../session";

export const DELETE_CONFIRMATION = "delete my data";

export const DeleteDataRequestSchema = z.strictObject({ confirm: z.string().max(100) });

const receiptSchema = z.object({
  receipt: z.coerce.number().int().positive(),
  counts: z.record(z.string(), z.coerce.number().int().nonnegative()),
});
export type DeletionReceipt = z.infer<typeof receiptSchema>;

export function isConfirmed(typed: string): boolean {
  return typed.trim().replace(/\s+/g, " ").toLowerCase() === DELETE_CONFIRMATION;
}

export async function deleteWorkspaceData(
  app: AppDatabase,
  session: GuestSession,
): Promise<DeletionReceipt> {
  return withTenant(app.db, session.userId, async (tx) => {
    const result = await tx.execute(
      sql`select delete_workspace_data(${session.workspaceId}::uuid) as result`,
    );
    const [row] = z
      .object({ rows: z.array(z.object({ result: receiptSchema })) })
      .parse(result).rows;
    if (row === undefined) throw new Error("delete_workspace_data returned no row");
    return row.result;
  });
}

async function assistantIds(app: AppDatabase, session: GuestSession): Promise<string[]> {
  const rows = await withTenant(app.db, session.userId, (tx) =>
    tx
      .select({ id: sql<string | null>`${artifacts.content}->>'id'` })
      .from(artifacts)
      .where(
        and(eq(artifacts.workspaceId, session.workspaceId), eq(artifacts.kind, ASSISTANT_KIND)),
      ),
  );
  return rows.flatMap((row) => (typeof row.id === "string" ? [row.id] : []));
}

export function evictAssistants(ids: readonly string[], store: unknown): number {
  if (typeof store !== "object" || store === null || !("records" in store)) return 0;
  const { records } = store;
  if (!(records instanceof Map)) return 0;
  let evicted = 0;
  for (const id of ids) if (records.delete(id)) evicted += 1;
  return evicted;
}

function expired(name: string, options: { httpOnly: boolean; secure: boolean }): string {
  return [
    `${name}=`,
    "Path=/",
    "Max-Age=0",
    ...(options.httpOnly ? ["HttpOnly"] : []),
    "SameSite=Lax",
    ...(options.secure ? ["Secure"] : []),
  ].join("; ");
}

export interface DeleteDeps extends ApiDeps {
  assistantStore?: () => unknown;
}

export async function handleDeleteData(request: Request, deps: DeleteDeps): Promise<Response> {
  const operator = await operatorFor(request, deps, "delete data");
  if (operator instanceof Response) return operator;
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const parsed = DeleteDataRequestSchema.safeParse(body.value);
  if (!parsed.success)
    return apiError(400, "invalid_request", "The delete request is not valid.", {
      issues: issuesOf(parsed.error),
    });
  if (!isConfirmed(parsed.data.confirm))
    return apiError(400, "invalid_request", `Type "${DELETE_CONFIRMATION}" to confirm.`);
  const { app, session } = operator;
  try {
    await stopAllRuns(app, session, deps);
    const assistants = await assistantIds(app, session);
    const receipt = await deleteWorkspaceData(app, session);
    evictAssistants(assistants, (deps.assistantStore ?? (() => assistantStores().assistants))());
    const headers = new Headers(NO_STORE);
    headers.append(
      "Set-Cookie",
      expired(SESSION_COOKIE, { httpOnly: true, secure: deps.production }),
    );
    for (const name of [AUTO_APPROVE_COOKIE, MISSION_PREF_COOKIE])
      headers.append("Set-Cookie", expired(name, { httpOnly: false, secure: deps.production }));
    return Response.json({ deleted: true, counts: receipt.counts }, { headers });
  } catch (error: unknown) {
    const code = postgresCode(error);
    if (code === "42501")
      return apiError(403, "forbidden", "Only the workspace owner can delete its data.");
    if (code === "P0002")
      return apiError(404, "not_found", "No workspace is visible to this session.");
    console.error("delete workspace data failed", error instanceof Error ? error.name : "unknown");
    return apiError(
      500,
      "internal",
      "Your data could not be deleted. Nothing was removed; runs that were active have been stopped.",
    );
  }
}
