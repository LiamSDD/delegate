import {
  approvals,
  auditLog,
  recordAudit,
  resolveApproval,
  type TenantTx,
  withTenant,
} from "@delegate/db";
import type { Actor, AwaitShipApproval, ShipDecision } from "@delegate/runtime";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import type { AppDatabase } from "./db";
import type { RunContext } from "./runs";
import { abortableSleep } from "./sse";

export const SHIP_APPROVAL_STEP = "ship";
export const SHIP_POLL_MS = 500;
export const SHIP_APPROVAL_TIMEOUT_MS = 10 * 60_000;
export const SHIP_DECISION_ACTION = "ship.decision";
export const SHIP_TIMEOUT_REASON = "Ship approval timed out, so nothing was shipped.";
export const SHIP_TIMEOUT_ACTOR: Actor = { type: "system", id: "ship-approval-timeout" };

const actionSchema = z.object({
  kind: z.literal("ship"),
  approvalId: z.string().min(1),
  mode: z.enum(["pull_request", "patch"]),
  repo: z.string(),
});

const decisionDetailsSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().max(500).optional(),
  actor: z.object({ type: z.enum(["member", "guest", "agent", "system"]), id: z.string() }),
});

export type RecordedShipDecision = z.infer<typeof decisionDetailsSchema>;

export interface PendingShip {
  approvalId: string;
  runtimeApprovalId: string;
  mode: "pull_request" | "patch";
}

export class ShipDecisionError extends Error {
  override readonly name = "ShipDecisionError";
  constructor(readonly code: "forbidden" | "already_resolved") {
    super(code);
  }
}

function postgresCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const code = (current as Error & { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = current.cause;
  }
  return null;
}

async function latestDecision(
  tx: TenantTx,
  approvalId: string,
): Promise<RecordedShipDecision | null> {
  const [entry] = await tx
    .select({ details: auditLog.details })
    .from(auditLog)
    .where(and(eq(auditLog.approvalId, approvalId), eq(auditLog.action, SHIP_DECISION_ACTION)))
    .orderBy(desc(auditLog.id))
    .limit(1);
  if (entry === undefined) return null;
  const parsed = decisionDetailsSchema.safeParse(entry.details);
  return parsed.success ? parsed.data : null;
}

export async function pendingShipApproval(
  app: AppDatabase,
  userId: string,
  runId: string,
): Promise<PendingShip | null> {
  if (!z.uuid().safeParse(runId).success) return null;
  const [row] = await withTenant(app.db, userId, (tx) =>
    tx
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.runId, runId),
          eq(approvals.stepId, SHIP_APPROVAL_STEP),
          eq(approvals.status, "pending"),
        ),
      )
      .orderBy(desc(approvals.requestedAt))
      .limit(1),
  );
  if (row === undefined) return null;
  const action = actionSchema.safeParse(row.action);
  return action.success
    ? { approvalId: row.id, runtimeApprovalId: action.data.approvalId, mode: action.data.mode }
    : null;
}

export async function recordShipDecision(
  app: AppDatabase,
  ctx: RunContext,
  approvalId: string,
  details: RecordedShipDecision,
): Promise<void> {
  try {
    await withTenant(app.db, ctx.userId, async (tx) => {
      await resolveApproval(tx, approvalId, details.decision);
      await recordAudit(tx, {
        workspaceId: ctx.workspaceId,
        action: SHIP_DECISION_ACTION,
        target: `run:${ctx.runId}`,
        decision: "n/a",
        approvalId,
        details: { ...details },
      });
    });
  } catch (error: unknown) {
    const code = postgresCode(error);
    if (code === "42501") throw new ShipDecisionError("forbidden");
    if (code === "55000") throw new ShipDecisionError("already_resolved");
    throw error;
  }
}

interface ApprovalRow {
  id: string;
  status: string;
  requestedAt: Date;
}

async function findOrOpen(
  app: AppDatabase,
  ctx: RunContext,
  request: Parameters<AwaitShipApproval>[0],
): Promise<ApprovalRow> {
  return withTenant(app.db, ctx.userId, async (tx) => {
    const rows = await tx
      .select({
        id: approvals.id,
        status: approvals.status,
        requestedAt: approvals.requestedAt,
        action: approvals.action,
      })
      .from(approvals)
      .where(and(eq(approvals.runId, ctx.runId), eq(approvals.stepId, SHIP_APPROVAL_STEP)))
      .orderBy(desc(approvals.requestedAt));
    const existing = rows.find((row) => {
      const action = actionSchema.safeParse(row.action);
      return action.success && action.data.approvalId === request.approvalId;
    });
    if (existing !== undefined) return existing;
    const [created] = await tx
      .insert(approvals)
      .values({
        runId: ctx.runId,
        workspaceId: ctx.workspaceId,
        stepId: SHIP_APPROVAL_STEP,
        action: {
          kind: "ship",
          approvalId: request.approvalId,
          mode: request.mode,
          repo: request.repo,
          branch: request.branch,
          base: request.base,
          diffStat: request.diffStat,
          patchArtifactId: request.patchArtifactId,
        },
      })
      .returning({
        id: approvals.id,
        status: approvals.status,
        requestedAt: approvals.requestedAt,
      });
    if (created === undefined) throw new Error("approval insert returned no row");
    return created;
  });
}

async function decisionFor(
  app: AppDatabase,
  userId: string,
  approvalId: string,
): Promise<RecordedShipDecision | null> {
  return withTenant(app.db, userId, async (tx) => {
    const [row] = await tx
      .select({ status: approvals.status })
      .from(approvals)
      .where(eq(approvals.id, approvalId));
    if (row === undefined || row.status === "pending") return null;
    return (
      (await latestDecision(tx, approvalId)) ?? {
        decision: row.status === "approved" ? "approved" : "rejected",
        actor: SHIP_TIMEOUT_ACTOR,
      }
    );
  });
}

function toDecision(recorded: RecordedShipDecision): ShipDecision {
  return recorded.decision === "approved"
    ? { decision: "approved", approvedBy: recorded.actor }
    : {
        decision: "rejected",
        rejectedBy: recorded.actor,
        ...(recorded.reason === undefined ? {} : { reason: recorded.reason }),
      };
}

export interface ShipApprovalWaiterOptions {
  app: AppDatabase;
  ctx: RunContext;
  pollMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

export function createShipApprovalWaiter(options: ShipApprovalWaiterOptions): AwaitShipApproval {
  const { app, ctx } = options;
  const pollMs = options.pollMs ?? SHIP_POLL_MS;
  const timeoutMs = options.timeoutMs ?? SHIP_APPROVAL_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  return async (request, signal) => {
    const row = await findOrOpen(app, ctx, request);
    const deadline = row.requestedAt.getTime() + timeoutMs;
    for (;;) {
      if (signal?.aborted === true)
        throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
      const recorded = await decisionFor(app, ctx.userId, row.id);
      if (recorded !== null) return toDecision(recorded);
      if (now() >= deadline) {
        const timedOut: RecordedShipDecision = {
          decision: "rejected",
          reason: SHIP_TIMEOUT_REASON,
          actor: SHIP_TIMEOUT_ACTOR,
        };
        try {
          await recordShipDecision(app, ctx, row.id, timedOut);
          return toDecision(timedOut);
        } catch (error: unknown) {
          if (!(error instanceof ShipDecisionError && error.code === "already_resolved"))
            throw error;
        }
        continue;
      }
      await abortableSleep(pollMs, signal ?? new AbortController().signal);
    }
  };
}
