import {
  approvals,
  auditLog,
  recordAudit,
  resolveApproval,
  type TenantTx,
  withTenant,
} from "@delegate/db";
import { mayAutoApprovePlan, type PlanApprovalRequest, type PlanStep } from "@delegate/runtime";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { PlanStepsSchema } from "@/lib/m2-contract";

import type { AppDatabase } from "./db";
import type { RunContext } from "./runs";
import { abortableSleep } from "./sse";

export const PLAN_APPROVAL_STEP = "plan";
export const PLAN_POLL_MS = 300;
export const PLAN_TIMEOUT_MS = 10 * 60_000;
export const PLAN_DECISION_ACTION = "plan.decision";

export type PlanDecision =
  | { decision: "approved"; steps?: PlanStep[]; auto?: boolean }
  | { decision: "rejected"; reason?: string };

export type AwaitPlanApproval = (
  plan: PlanApprovalRequest,
  signal?: AbortSignal,
) => Promise<PlanDecision>;

const actionSchema = z.object({ kind: z.literal("plan"), steps: PlanStepsSchema });

const decisionDetailsSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  steps: PlanStepsSchema.optional(),
  reason: z.string().optional(),
  auto: z.boolean().optional(),
});

export type RecordedPlanDecision = z.infer<typeof decisionDetailsSchema>;

export interface PendingPlan {
  approvalId: string;
  steps: PlanStep[];
}

export async function pendingPlanApproval(
  app: AppDatabase,
  userId: string,
  runId: string,
): Promise<PendingPlan | null> {
  if (!z.uuid().safeParse(runId).success) return null;
  const [row] = await withTenant(app.db, userId, (tx) =>
    tx
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.runId, runId),
          eq(approvals.stepId, PLAN_APPROVAL_STEP),
          eq(approvals.status, "pending"),
        ),
      )
      .orderBy(desc(approvals.requestedAt))
      .limit(1),
  );
  if (row === undefined) return null;
  const action = actionSchema.safeParse(row.action);
  return action.success ? { approvalId: row.id, steps: action.data.steps } : null;
}

async function openPlanApproval(app: AppDatabase, ctx: RunContext, steps: PlanStep[]) {
  return withTenant(app.db, ctx.userId, async (tx) => {
    const [row] = await tx
      .insert(approvals)
      .values({
        runId: ctx.runId,
        workspaceId: ctx.workspaceId,
        stepId: PLAN_APPROVAL_STEP,
        action: { kind: "plan", steps },
      })
      .returning({ id: approvals.id });
    if (row === undefined) throw new Error("approval insert returned no row");
    return row.id;
  });
}

async function latestDecision(
  tx: TenantTx,
  approvalId: string,
): Promise<RecordedPlanDecision | null> {
  const [entry] = await tx
    .select({ details: auditLog.details })
    .from(auditLog)
    .where(and(eq(auditLog.approvalId, approvalId), eq(auditLog.action, PLAN_DECISION_ACTION)))
    .orderBy(desc(auditLog.id))
    .limit(1);
  if (entry === undefined) return null;
  const parsed = decisionDetailsSchema.safeParse(entry.details);
  return parsed.success ? parsed.data : null;
}

export async function readPlanDecision(
  app: AppDatabase,
  userId: string,
  runId: string,
): Promise<RecordedPlanDecision | null> {
  return withTenant(app.db, userId, async (tx) => {
    const [row] = await tx
      .select({ id: approvals.id, status: approvals.status })
      .from(approvals)
      .where(and(eq(approvals.runId, runId), eq(approvals.stepId, PLAN_APPROVAL_STEP)))
      .orderBy(desc(approvals.requestedAt))
      .limit(1);
    if (row === undefined || row.status === "pending") return null;
    return latestDecision(tx, row.id);
  });
}

async function decisionFor(app: AppDatabase, userId: string, approvalId: string) {
  return withTenant(app.db, userId, async (tx) => {
    const [row] = await tx
      .select({ status: approvals.status })
      .from(approvals)
      .where(eq(approvals.id, approvalId));
    if (row === undefined || row.status === "pending") return null;
    return (
      (await latestDecision(tx, approvalId)) ?? {
        decision: row.status === "approved" ? ("approved" as const) : ("rejected" as const),
      }
    );
  });
}

export type DecidePlanError = "forbidden" | "already_resolved";

export class PlanDecisionError extends Error {
  override readonly name = "PlanDecisionError";
  constructor(readonly code: DecidePlanError) {
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

export async function recordPlanDecision(
  app: AppDatabase,
  ctx: RunContext,
  approvalId: string,
  details: RecordedPlanDecision,
): Promise<void> {
  try {
    await withTenant(app.db, ctx.userId, async (tx) => {
      await resolveApproval(tx, approvalId, details.decision);
      await recordAudit(tx, {
        workspaceId: ctx.workspaceId,
        action: PLAN_DECISION_ACTION,
        target: `run:${ctx.runId}`,
        decision: "n/a",
        approvalId,
        details: { ...details },
      });
    });
  } catch (error: unknown) {
    const code = postgresCode(error);
    if (code === "42501") throw new PlanDecisionError("forbidden");
    if (code === "55000") throw new PlanDecisionError("already_resolved");
    throw error;
  }
}

function toDecision(recorded: RecordedPlanDecision): PlanDecision {
  if (recorded.decision === "approved") {
    return recorded.steps === undefined
      ? { decision: "approved" }
      : { decision: "approved", steps: recorded.steps };
  }
  return recorded.reason === undefined
    ? { decision: "rejected" }
    : { decision: "rejected", reason: recorded.reason };
}

export interface PlanApprovalWaiterOptions {
  app: AppDatabase;
  ctx: RunContext;
  autoApprove: boolean;
  pollMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

export function createPlanApprovalWaiter(options: PlanApprovalWaiterOptions): AwaitPlanApproval {
  const { app, ctx } = options;
  const pollMs = options.pollMs ?? PLAN_POLL_MS;
  const timeoutMs = options.timeoutMs ?? PLAN_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  return async (plan, signal) => {
    const approvalId = await openPlanApproval(app, ctx, plan.steps);
    if (options.autoApprove && mayAutoApprovePlan(plan)) {
      await recordPlanDecision(app, ctx, approvalId, { decision: "approved", auto: true });
      return { decision: "approved", auto: true };
    }
    const deadline = now() + timeoutMs;
    for (;;) {
      if (signal?.aborted === true) {
        throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
      }
      const recorded = await decisionFor(app, ctx.userId, approvalId);
      if (recorded !== null) return toDecision(recorded);
      if (now() >= deadline) {
        const timedOut = { decision: "rejected" as const, reason: "Plan approval timed out." };
        try {
          await recordPlanDecision(app, ctx, approvalId, timedOut);
          return timedOut;
        } catch (error: unknown) {
          if (!(error instanceof PlanDecisionError && error.code === "already_resolved"))
            throw error;
        }
        continue;
      }
      await abortableSleep(pollMs, signal ?? new AbortController().signal);
    }
  };
}
