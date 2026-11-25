import { approvals, runEvents, runs, withTenant } from "@delegate/db";
import {
  DiffStatSchema,
  type PlanStep,
  ShipApprovalRequestedPayloadSchema,
  ShipModeSchema,
  type TestRunSummary,
} from "@delegate/runtime";
import { sha256Text, TOOL_APPROVAL_ARGS_MAX_BYTES } from "@delegate/runtime/server";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { PlanStepsSchema } from "@/lib/m2-contract";
import { runTarget } from "@/lib/runs/target";

import type { AppDatabase } from "../db";
import { PLAN_APPROVAL_STEP, PLAN_TIMEOUT_MS } from "../plan-approval";
import type { GuestSession } from "../session";
import { SHIP_APPROVAL_STEP, SHIP_APPROVAL_TIMEOUT_MS } from "../ship-approval";
import { TOOL_APPROVAL_STEP, TOOL_APPROVAL_TIMEOUT_MS } from "../tool-approval";

export const INBOX_LIMIT = 100;

export const APPROVAL_TIMEOUT_MS = {
  plan: PLAN_TIMEOUT_MS,
  ship: SHIP_APPROVAL_TIMEOUT_MS,
  tool: TOOL_APPROVAL_TIMEOUT_MS,
} as const;

export type InboxKind = keyof typeof APPROVAL_TIMEOUT_MS;

interface InboxBase {
  approvalRowId: string;
  runId: string;
  mission: string;
  target: string | null;
  requestedAt: string;
  expiresAt: string;
  expired: boolean;
}

export interface PlanInboxItem extends InboxBase {
  kind: "plan";
  steps: PlanStep[];
}

export interface ShipInboxItem extends InboxBase {
  kind: "ship";
  mode: z.infer<typeof ShipModeSchema>;
  repo: string;
  branch: string | null;
  base: string | null;
  diffStat: z.infer<typeof DiffStatSchema> | null;
  title: string | null;
  reason: string | null;
  baseline: TestRunSummary | null;
  after: TestRunSummary | null;
}

export interface ToolInboxItem extends InboxBase {
  kind: "tool";
  approvalId: string;
  tool: string;
  server: string | null;
  action: string;
  capability: string | null;
  policyId: string | null;
  argsJson: string;
  argsSha256: string;
}

export type InboxItem = PlanInboxItem | ShipInboxItem | ToolInboxItem;

const KIND_OF_STEP: Record<string, InboxKind> = {
  [PLAN_APPROVAL_STEP]: "plan",
  [SHIP_APPROVAL_STEP]: "ship",
  [TOOL_APPROVAL_STEP]: "tool",
};

const planAction = z.object({ kind: z.literal("plan"), steps: PlanStepsSchema });

const shipAction = z.object({
  kind: z.literal("ship"),
  approvalId: z.string().min(1),
  mode: ShipModeSchema,
  repo: z.string(),
  branch: z.string().optional(),
  base: z.string().optional(),
  diffStat: DiffStatSchema.optional(),
});

const toolAction = z
  .object({
    kind: z.literal("tool"),
    approvalId: z.string().min(1),
    tool: z.string().min(1),
    argsJson: z.string().max(TOOL_APPROVAL_ARGS_MAX_BYTES),
    argsSha256: z.string().regex(/^[0-9a-f]{64}$/),
    capability: z.string().optional(),
    policyId: z.string().optional(),
  })
  .refine((action) => sha256Text(action.argsJson) === action.argsSha256);

const inputRecord = z.record(z.string(), z.unknown());
const CONNECTOR_TOOL = /^mcp__([a-z0-9][a-z0-9-]{0,31})__(.+)$/;

interface PendingRow {
  id: string;
  runId: string;
  stepId: string;
  action: unknown;
  requestedAt: Date;
  mission: string;
  input: unknown;
}

function base(row: PendingRow, kind: InboxKind, now: Date): InboxBase {
  const input = inputRecord.safeParse(row.input);
  const expiresAt = new Date(row.requestedAt.getTime() + APPROVAL_TIMEOUT_MS[kind]);
  return {
    approvalRowId: row.id,
    runId: row.runId,
    mission: row.mission,
    target: input.success ? runTarget(input.data) : null,
    requestedAt: row.requestedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    expired: expiresAt.getTime() <= now.getTime(),
  };
}

type ShipRequest = z.infer<typeof ShipApprovalRequestedPayloadSchema>;

function toItem(
  row: PendingRow,
  now: Date,
  shipRequests: ReadonlyMap<string, ShipRequest>,
): { key: string; item: InboxItem } | null {
  const kind = KIND_OF_STEP[row.stepId];
  if (kind === undefined) return null;
  if (kind === "plan") {
    const action = planAction.safeParse(row.action);
    if (!action.success) return null;
    return {
      key: `${row.runId}:plan`,
      item: { ...base(row, kind, now), kind, steps: action.data.steps },
    };
  }
  if (kind === "ship") {
    const action = shipAction.safeParse(row.action);
    if (!action.success) return null;
    const request = shipRequests.get(`${row.runId}:${action.data.approvalId}`);
    return {
      key: `${row.runId}:ship`,
      item: {
        ...base(row, kind, now),
        kind,
        mode: action.data.mode,
        repo: action.data.repo,
        branch: action.data.branch ?? request?.branch ?? null,
        base: action.data.base ?? request?.base ?? null,
        diffStat: action.data.diffStat ?? request?.diffStat ?? null,
        title: request?.title ?? null,
        reason: request?.reason ?? null,
        baseline: request?.baseline ?? null,
        after: request?.after ?? null,
      },
    };
  }
  const action = toolAction.safeParse(row.action);
  if (!action.success) return null;
  const match = CONNECTOR_TOOL.exec(action.data.tool);
  return {
    key: `${row.runId}:tool:${action.data.approvalId}`,
    item: {
      ...base(row, kind, now),
      kind,
      approvalId: action.data.approvalId,
      tool: action.data.tool,
      server: match?.[1] ?? null,
      action: match?.[2] ?? action.data.tool,
      capability: action.data.capability ?? null,
      policyId: action.data.policyId ?? null,
      argsJson: action.data.argsJson,
      argsSha256: action.data.argsSha256,
    },
  };
}

export interface ApprovalsInbox {
  items: InboxItem[];
  truncated: boolean;
}

export async function listPendingApprovals(
  app: AppDatabase,
  session: GuestSession,
  now = new Date(),
): Promise<ApprovalsInbox> {
  return withTenant(app.db, session.userId, async (tx) => {
    const rows: PendingRow[] = await tx
      .select({
        id: approvals.id,
        runId: approvals.runId,
        stepId: approvals.stepId,
        action: approvals.action,
        requestedAt: approvals.requestedAt,
        mission: runs.mission,
        input: runs.input,
      })
      .from(approvals)
      .innerJoin(runs, eq(runs.id, approvals.runId))
      .where(
        and(
          eq(approvals.workspaceId, session.workspaceId),
          eq(approvals.status, "pending"),
          inArray(approvals.stepId, Object.keys(KIND_OF_STEP)),
          sql`${runs.status} not in ('completed', 'failed')`,
        ),
      )
      .orderBy(desc(approvals.requestedAt), desc(approvals.id))
      .limit(INBOX_LIMIT + 1);

    const shipRuns = [
      ...new Set(rows.filter((row) => row.stepId === SHIP_APPROVAL_STEP).map((row) => row.runId)),
    ];
    const shipRequests = new Map<string, ShipRequest>();
    if (shipRuns.length > 0) {
      const events = await tx
        .select({ runId: runEvents.runId, payload: runEvents.payload })
        .from(runEvents)
        .where(
          and(inArray(runEvents.runId, shipRuns), eq(runEvents.type, "ship.approval.requested")),
        )
        .orderBy(desc(runEvents.seq));
      for (const event of events) {
        const payload = ShipApprovalRequestedPayloadSchema.safeParse(event.payload);
        if (!payload.success) continue;
        const key = `${event.runId}:${payload.data.approvalId}`;
        if (!shipRequests.has(key)) shipRequests.set(key, payload.data);
      }
    }

    const newest = new Map<string, InboxItem>();
    for (const row of rows.slice(0, INBOX_LIMIT)) {
      const entry = toItem(row, now, shipRequests);
      if (entry !== null && !newest.has(entry.key)) newest.set(entry.key, entry.item);
    }
    return {
      truncated: rows.length > INBOX_LIMIT,
      items: [...newest.values()].sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt)),
    };
  });
}
