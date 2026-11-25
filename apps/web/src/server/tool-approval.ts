import {
  approvals,
  auditLog,
  recordAudit,
  resolveApproval,
  type TenantTx,
  withTenant,
} from "@delegate/db";
import type { Actor } from "@delegate/runtime";
import {
  sha256Text,
  TOOL_APPROVAL_ARGS_MAX_BYTES,
  type ToolApprovalGate,
  type ToolApprovalRequest,
  type ToolApprovalResolution,
} from "@delegate/runtime/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import type { AppDatabase } from "./db";
import type { RunContext } from "./runs";
import { abortableSleep } from "./sse";

export const TOOL_APPROVAL_STEP = "tool";
export const TOOL_POLL_MS = 500;
export const TOOL_APPROVAL_TIMEOUT_MS = 10 * 60_000;
export const TOOL_DECISION_ACTION = "tool.decision";
export const TOOL_TIMEOUT_REASON = "Nobody approved the tool call in time, so it did not run.";
export const TOOL_TIMEOUT_ACTOR: Actor = { type: "system", id: "tool-approval-timeout" };

const SHA256 = /^[0-9a-f]{64}$/;

const actionSchema = z
  .object({
    kind: z.literal("tool"),
    approvalId: z.string().min(1),
    tool: z.string().min(1),
    argsSummary: z.string(),
    argsJson: z.string().max(TOOL_APPROVAL_ARGS_MAX_BYTES),
    argsSha256: z.string().regex(SHA256),
  })
  .refine((action) => sha256Text(action.argsJson) === action.argsSha256);

const decisionDetailsSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().max(500).optional(),
  actor: z.object({ type: z.enum(["member", "guest", "agent", "system"]), id: z.string() }),
});
export type RecordedToolDecision = z.infer<typeof decisionDetailsSchema>;

export class ToolDecisionError extends Error {
  override readonly name = "ToolDecisionError";
  constructor(readonly code: "forbidden" | "already_resolved" | "not_found") {
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

export interface PendingToolApproval {
  approvalId: string;
  runtimeApprovalId: string;
  tool: string;
  argsSummary: string;
  argsJson: string;
  argsSha256: string;
}

export async function pendingToolApprovals(
  app: AppDatabase,
  userId: string,
  runId: string,
): Promise<PendingToolApproval[]> {
  if (!z.uuid().safeParse(runId).success) return [];
  const rows = await withTenant(app.db, userId, (tx) =>
    tx
      .select({ id: approvals.id, action: approvals.action })
      .from(approvals)
      .where(
        and(
          eq(approvals.runId, runId),
          eq(approvals.stepId, TOOL_APPROVAL_STEP),
          eq(approvals.status, "pending"),
        ),
      )
      .orderBy(desc(approvals.requestedAt)),
  );
  return rows.flatMap((row) => {
    const action = actionSchema.safeParse(row.action);
    return action.success
      ? [
          {
            approvalId: row.id,
            runtimeApprovalId: action.data.approvalId,
            tool: action.data.tool,
            argsSummary: action.data.argsSummary,
            argsJson: action.data.argsJson,
            argsSha256: action.data.argsSha256,
          },
        ]
      : [];
  });
}

export async function recordToolDecision(
  app: AppDatabase,
  ctx: RunContext,
  approvalId: string,
  details: RecordedToolDecision,
): Promise<void> {
  try {
    await withTenant(app.db, ctx.userId, async (tx) => {
      await resolveApproval(tx, approvalId, details.decision);
      await recordAudit(tx, {
        workspaceId: ctx.workspaceId,
        action: TOOL_DECISION_ACTION,
        target: `run:${ctx.runId}`,
        decision: "n/a",
        approvalId,
        details: { ...details },
      });
    });
  } catch (error: unknown) {
    const code = postgresCode(error);
    if (code === "42501") throw new ToolDecisionError("forbidden");
    if (code === "55000") throw new ToolDecisionError("already_resolved");
    throw error;
  }
}

async function latestDecision(tx: TenantTx, approvalId: string) {
  const [entry] = await tx
    .select({ details: auditLog.details })
    .from(auditLog)
    .where(and(eq(auditLog.approvalId, approvalId), eq(auditLog.action, TOOL_DECISION_ACTION)))
    .orderBy(desc(auditLog.id))
    .limit(1);
  if (entry === undefined) return null;
  const parsed = decisionDetailsSchema.safeParse(entry.details);
  return parsed.success ? parsed.data : null;
}

export class ToolArgumentsError extends Error {
  override readonly name = "ToolArgumentsError";
}

async function findOrOpen(app: AppDatabase, ctx: RunContext, request: ToolApprovalRequest) {
  if (
    new TextEncoder().encode(request.argsJson).byteLength > TOOL_APPROVAL_ARGS_MAX_BYTES ||
    sha256Text(request.argsJson) !== request.argsSha256
  )
    throw new ToolArgumentsError("The tool arguments cannot be shown in full for approval");
  return withTenant(app.db, ctx.userId, async (tx) => {
    const rows = await tx
      .select({
        id: approvals.id,
        requestedAt: approvals.requestedAt,
        action: approvals.action,
      })
      .from(approvals)
      .where(
        and(
          eq(approvals.runId, ctx.runId),
          eq(approvals.stepId, TOOL_APPROVAL_STEP),
          eq(approvals.status, "pending"),
        ),
      )
      .orderBy(desc(approvals.requestedAt));
    const existing = rows.find((row) => {
      const action = actionSchema.safeParse(row.action);
      return (
        action.success &&
        action.data.approvalId === request.approvalId &&
        action.data.tool === request.tool &&
        action.data.argsSha256 === request.argsSha256
      );
    });
    if (existing !== undefined) return existing;
    const [created] = await tx
      .insert(approvals)
      .values({
        runId: ctx.runId,
        workspaceId: ctx.workspaceId,
        stepId: TOOL_APPROVAL_STEP,
        action: {
          kind: "tool",
          approvalId: request.approvalId,
          tool: request.tool,
          argsSummary: request.argsSummary,
          argsJson: request.argsJson,
          argsSha256: request.argsSha256,
          capability: request.capability,
          policyId: request.policyId,
        },
      })
      .returning({ id: approvals.id, requestedAt: approvals.requestedAt });
    if (created === undefined) throw new Error("approval insert returned no row");
    return created;
  });
}

async function decisionFor(
  app: AppDatabase,
  userId: string,
  approvalId: string,
): Promise<RecordedToolDecision | null> {
  return withTenant(app.db, userId, async (tx) => {
    const [row] = await tx
      .select({ status: approvals.status })
      .from(approvals)
      .where(eq(approvals.id, approvalId));
    if (row === undefined || row.status === "pending") return null;
    return (
      (await latestDecision(tx, approvalId)) ?? {
        decision: row.status === "approved" ? "approved" : "rejected",
        actor: TOOL_TIMEOUT_ACTOR,
      }
    );
  });
}

function toResolution(recorded: RecordedToolDecision): ToolApprovalResolution {
  return {
    resolution: recorded.decision,
    resolvedBy: recorded.actor,
    ...(recorded.reason === undefined ? {} : { note: recorded.reason }),
  };
}

export interface ToolApprovalGateOptions {
  app: AppDatabase;
  ctx: RunContext;
  signal?: AbortSignal;
  pollMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

export function createToolApprovalGate(options: ToolApprovalGateOptions): ToolApprovalGate {
  const { app, ctx } = options;
  const pollMs = options.pollMs ?? TOOL_POLL_MS;
  const timeoutMs = options.timeoutMs ?? TOOL_APPROVAL_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const signal = options.signal ?? new AbortController().signal;
  return {
    async decide(request) {
      const row = await findOrOpen(app, ctx, request);
      const deadline = row.requestedAt.getTime() + timeoutMs;
      for (;;) {
        if (signal.aborted) return { resolution: "rejected", resolvedBy: TOOL_TIMEOUT_ACTOR };
        const recorded = await decisionFor(app, ctx.userId, row.id);
        if (recorded !== null) return toResolution(recorded);
        if (now() >= deadline) {
          const timedOut: RecordedToolDecision = {
            decision: "rejected",
            reason: TOOL_TIMEOUT_REASON,
            actor: TOOL_TIMEOUT_ACTOR,
          };
          try {
            await recordToolDecision(app, ctx, row.id, timedOut);
            return toResolution(timedOut);
          } catch (error: unknown) {
            if (!(error instanceof ToolDecisionError && error.code === "already_resolved"))
              throw error;
          }
          continue;
        }
        await abortableSleep(pollMs, signal).catch(() => undefined);
      }
    },
  };
}
