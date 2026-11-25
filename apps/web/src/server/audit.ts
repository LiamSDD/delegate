import { runEventFromRow, runEvents, runs, withTenant } from "@delegate/db";
import { PolicyDecisionKindSchema, type PolicyDecisionKind } from "@delegate/runtime";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { AppDatabase } from "./db";
import type { GuestSession } from "./session";

export const POLICY_DECISIONS = PolicyDecisionKindSchema.options;
export const AUDIT_PAGE_SIZE = 200;

export interface PolicyDecisionEntry {
  runId: string;
  seq: number;
  at: Date;
  mission: string;
  target: string | null;
  stepId: string | null;
  tool: string;
  decision: PolicyDecisionKind;
  policyId: string;
  reason: string;
  redactions: number;
}

export interface AuditListing {
  entries: PolicyDecisionEntry[];
  counts: Record<PolicyDecisionKind, number>;
}

export function parseDecisionFilter(value: unknown): PolicyDecisionKind | undefined {
  const parsed = PolicyDecisionKindSchema.safeParse(Array.isArray(value) ? value[0] : value);
  return parsed.success ? parsed.data : undefined;
}

const inputUrl = z.object({ url: z.string() });

function targetOf(input: unknown): string | null {
  const parsed = inputUrl.safeParse(input);
  if (!parsed.success) return null;
  try {
    return new URL(parsed.data.url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

const countRow = z.object({ decision: z.string().nullable(), count: z.coerce.number().int() });

export async function listPolicyDecisions(
  app: AppDatabase,
  session: GuestSession,
  options: { decision?: PolicyDecisionKind; limit?: number } = {},
): Promise<AuditListing> {
  return withTenant(app.db, session.userId, async (tx) => {
    const scope = and(
      eq(runEvents.workspaceId, session.workspaceId),
      eq(runEvents.type, "policy.decided"),
    );
    const rows = await tx
      .select({ event: runEvents, mission: runs.mission, input: runs.input })
      .from(runEvents)
      .innerJoin(runs, eq(runs.id, runEvents.runId))
      .where(
        options.decision === undefined
          ? scope
          : and(scope, sql`${runEvents.payload}->>'decision' = ${options.decision}`),
      )
      .orderBy(desc(runEvents.createdAt), desc(runEvents.id))
      .limit(options.limit ?? AUDIT_PAGE_SIZE);
    const grouped = await tx
      .select({
        decision: sql<string | null>`${runEvents.payload}->>'decision'`,
        count: sql<number>`count(*)`,
      })
      .from(runEvents)
      .where(scope)
      .groupBy(sql`${runEvents.payload}->>'decision'`);
    const counts: Record<PolicyDecisionKind, number> = { allow: 0, deny: 0, require_approval: 0 };
    for (const raw of grouped) {
      const row = countRow.parse(raw);
      const decision = parseDecisionFilter(row.decision);
      if (decision !== undefined) counts[decision] = row.count;
    }
    const entries = rows.flatMap(({ event: row, mission, input }) => {
      const event = runEventFromRow(row);
      if (event.type !== "policy.decided") return [];
      return [
        {
          runId: event.runId,
          seq: event.seq,
          at: row.createdAt,
          mission,
          target: targetOf(input),
          stepId: event.stepId ?? null,
          tool: event.payload.tool,
          decision: event.payload.decision,
          policyId: event.payload.policyId,
          reason: event.payload.reason,
          redactions: event.payload.redactions ?? 0,
        },
      ];
    });
    return { entries, counts };
  });
}
