import { holdLease, type RunLease } from "@delegate/runtime/server";
import { redactPii, type RunEvent } from "@delegate/runtime";

import type { AppDatabase } from "./db";
import type { RunnableMissionId } from "@/lib/m2-contract";

import type { MissionRunner } from "./mission-runner";
import { type AwaitPlanApproval, createPlanApprovalWaiter } from "./plan-approval";
import type { RunRegistry } from "./run-registry";
import {
  appendEvent,
  type EventDraft,
  isTerminalEventType,
  RunAlreadyTerminalError,
  type RunContext,
} from "./runs";

const MAX_ERROR_MESSAGE = 300;

function publicError(error: unknown): { message: string; redactions: number } {
  const { text, count } = redactPii(error instanceof Error ? error.message : "Unknown error");
  return {
    message: text.length > MAX_ERROR_MESSAGE ? `${text.slice(0, MAX_ERROR_MESSAGE)}…` : text,
    redactions: count,
  };
}

export interface ExecuteRunOptions {
  app: AppDatabase;
  ctx: RunContext;
  missionId: RunnableMissionId;
  input: Record<string, unknown>;
  runner: MissionRunner;
  registry: RunRegistry;
  autoApprovePlan?: boolean;
  awaitPlanApproval?: AwaitPlanApproval;
  lease?: RunLease;
  resumeFrom?: readonly RunEvent[];
}

export async function executeRun(options: ExecuteRunOptions): Promise<void> {
  if (options.lease === undefined) {
    await executeHeld(options, undefined, () => true);
    return;
  }
  try {
    const held = await holdLease(options.lease, undefined, (signal, isHeld) =>
      executeHeld(options, signal, isHeld),
    );
    if (!held.acquired) console.warn("run lease held by another worker", options.ctx.runId);
  } catch (error: unknown) {
    console.error("run lease failed", options.ctx.runId, publicError(error).message);
  }
}

async function executeHeld(
  options: ExecuteRunOptions,
  leaseSignal: AbortSignal | undefined,
  isHeld: () => boolean,
): Promise<void> {
  const { app, ctx, registry } = options;
  const controller = registry.register(ctx.runId);
  const signal =
    leaseSignal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, leaseSignal]);
  const progress = { terminal: false };
  const emit = async (draft: EventDraft) => {
    if (progress.terminal || !isHeld()) throw new RunAlreadyTerminalError(ctx.runId);
    const event = await appendEvent(app, ctx, draft);
    if (isTerminalEventType(event.type)) progress.terminal = true;
  };
  const finish = async (draft: EventDraft) => {
    try {
      await appendEvent(app, ctx, draft);
    } catch (error: unknown) {
      if (!(error instanceof RunAlreadyTerminalError)) throw error;
    }
  };

  try {
    const result = await options.runner({
      runId: ctx.runId,
      missionId: options.missionId,
      input: options.input,
      emit,
      signal,
      scope: { workspaceId: ctx.workspaceId, userId: ctx.userId },
      ...(options.resumeFrom === undefined ? {} : { resumeFrom: options.resumeFrom }),
      planApprover:
        options.autoApprovePlan === true
          ? { type: "system", id: "auto-approve" }
          : { type: "guest", id: ctx.userId },
      awaitPlanApproval:
        options.awaitPlanApproval ??
        createPlanApprovalWaiter({ app, ctx, autoApprove: options.autoApprovePlan ?? false }),
    });
    if (!progress.terminal && !signal.aborted) {
      await finish(
        result.status === "completed"
          ? { type: "run.completed", payload: { summary: "The mission reported completion." } }
          : {
              type: "run.failed",
              payload: {
                error: { code: "mission_failed", message: "The mission reported a failure." },
              },
            },
      );
    }
  } catch (error: unknown) {
    if (!progress.terminal && !signal.aborted && !(error instanceof RunAlreadyTerminalError)) {
      const { message, redactions } = publicError(error);
      console.error("run failed", ctx.runId, message);
      await finish({
        type: "run.failed",
        payload: {
          error: { code: "runtime_error", message },
          ...(redactions === 0 ? {} : { redactions }),
        },
      });
    }
  } finally {
    registry.unregister(ctx.runId);
  }
}
