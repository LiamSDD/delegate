import { runs, withTenant } from "@delegate/db";
import type { ListRunsQuerySchema, RunList, RunSummary } from "@delegate/sdk/contract";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { runTarget } from "@/lib/runs/target";

import type { AppDatabase } from "../db";
import type { GuestSession } from "../session";
import { V1Error } from "./errors";

const CursorSchema = z.tuple([
  z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
  z.uuid(),
]);

export interface RunCursor {
  createdAt: string;
  id: string;
}

export function encodeRunCursor(cursor: RunCursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt, cursor.id]), "utf8").toString("base64url");
}

export function decodeRunCursor(raw: string): RunCursor {
  try {
    const [createdAt, id] = CursorSchema.parse(
      JSON.parse(Buffer.from(raw, "base64url").toString("utf8")),
    );
    return { createdAt, id };
  } catch {
    throw new V1Error("invalid_request", "The run list request is not valid.", {
      issues: ["cursor: not a cursor returned by this API"],
    });
  }
}

const inputRecord = z.record(z.string(), z.unknown());

export async function listRunsPage(
  app: AppDatabase,
  session: GuestSession,
  query: z.output<typeof ListRunsQuerySchema>,
  origin: string,
): Promise<RunList> {
  const cursor = query.cursor === undefined ? undefined : decodeRunCursor(query.cursor);
  const rows = await withTenant(app.db, session.userId, (tx) =>
    tx
      .select({
        id: runs.id,
        mission: runs.mission,
        input: runs.input,
        status: runs.status,
        createdAt: runs.createdAt,
        startedAt: runs.startedAt,
        finishedAt: runs.finishedAt,
        position: sql<string>`to_char(${runs.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(runs)
      .where(
        and(
          eq(runs.workspaceId, session.workspaceId),
          query.status === undefined ? undefined : eq(runs.status, query.status),
          cursor === undefined
            ? undefined
            : sql`(${runs.createdAt}, ${runs.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
        ),
      )
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .limit(query.limit + 1),
  );
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  const data: RunSummary[] = page.map((row) => {
    const input = inputRecord.safeParse(row.input);
    return {
      id: row.id,
      mission: row.mission,
      target: input.success ? runTarget(input.data) : null,
      status: row.status,
      execution: input.success && input.data.execution === "simulated" ? "simulated" : "live",
      createdAt: row.createdAt.toISOString(),
      startedAt: row.startedAt?.toISOString() ?? null,
      finishedAt: row.finishedAt?.toISOString() ?? null,
      webUrl: `${origin}/runs/${row.id}`,
    };
  });
  return {
    data,
    nextCursor:
      rows.length > query.limit && last !== undefined
        ? encodeRunCursor({ createdAt: last.position, id: last.id })
        : null,
  };
}
