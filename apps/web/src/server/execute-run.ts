import { type FindInstallation, holdLease, type RunLease } from "@delegate/runtime/server";
import { type AwaitShipApproval, redactPii, type RunEvent } from "@delegate/runtime";

import type { AppDatabase } from "./db";
import { type ExecutableMissionId, SHIP_MISSION_ID } from "@/lib/m2-contract";

import { handoffMarkerDraft } from "@/lib/runs/resume";

import { currentSlice, hasRoomForWork, type Slice } from "./invocation";
import type { MissionConnections, MissionRunner } from "./mission-runner";
import { type AwaitPlanApproval, createPlanApprovalWaiter } from "./plan-approval";
import type { RunRegistry } from "./run-registry";
import { createShipApprovalWaiter } from "./ship-approval";
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
  missionId: ExecutableMissionId;
  input: Record<string, unknown>;
  runner: MissionRunner;
  registry: RunRegistry;
  autoApprovePlan?: boolean;
  awaitPlanApproval?: AwaitPlanApproval;
  awaitShipApproval?: AwaitShipApproval;
  findInstallation?: FindInstallation;
  lease?: RunLease;
  resumeFrom?: readonly RunEvent[];
  connections?: MissionConnections;
  onSettled?: () => Promise<void>;
  slice?: Slice | null;
  now?: () => number;
  planWait?: { pollMs?: number; inlineWaitMs?: number };
}

export class RunHandoffError extends Error {
  override readonly name = "RunHandoffError";
  constructor(readonly kind: "handoff" | "park") {
    super(
      kind === "park"
        ? "The run is waiting for a plan decision without holding a worker"
        : "The run is handed off to a new invocation",
    );
  }
}

export async function executeRun(options: ExecuteRunOptions): Promise<void> {
  try {
    await executeLeased(options);
  } finally {
    if (options.onSettled !== undefined)
      await options.onSettled().catch((error: unknown) => {
        console.error("run settle hook failed", options.ctx.runId, publicError(error).message);
      });
  }
}

async function executeLeased(options: ExecuteRunOptions): Promise<void> {
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
  const now = options.now ?? Date.now;
  const slice =
    options.lease === undefined || options.slice === null
      ? undefined
      : (options.slice ?? currentSlice());
  const controller = registry.register(ctx.runId);
  const handoff = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    handoff.signal,
    ...(leaseSignal === undefined ? [] : [leaseSignal]),
  ]);
  const progress: { terminal: boolean; stopped: RunHandoffError["kind"] | null } = {
    terminal: false,
    stopped: null,
  };
  const inflight = new Set<Promise<unknown>>();
  const emit = async (draft: EventDraft) => {
    if (progress.terminal || progress.stopped !== null || !isHeld())
      throw new RunAlreadyTerminalError(ctx.runId);
    const appending = appendEvent(app, ctx, draft);
    inflight.add(appending);
    try {
      const event = await appending;
      if (isTerminalEventType(event.type)) progress.terminal = true;
    } finally {
      inflight.delete(appending);
    }
  };
  const finish = async (draft: EventDraft) => {
    try {
      await appendEvent(app, ctx, draft);
    } catch (error: unknown) {
      if (!(error instanceof RunAlreadyTerminalError)) throw error;
    }
  };
  const ended = () => progress.terminal;
  const stop = async (kind: RunHandoffError["kind"]) => {
    if (progress.stopped !== null || progress.terminal) return;
    progress.stopped = kind;
    await Promise.allSettled([...inflight]);
    if (kind === "handoff" && !ended() && isHeld() && slice !== undefined)
      await finish(
        handoffMarkerDraft({ elapsedMs: now() - slice.startedAt, budgetMs: slice.budgetMs }),
      );
    handoff.abort(new RunHandoffError(kind));
  };
  const park = async (): Promise<never> => {
    await stop("park");
    throw new RunHandoffError("park");
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (slice !== undefined) {
      if (!hasRoomForWork(now(), slice)) {
        await stop("handoff");
        return;
      }
      timer = setTimeout(
        () => {
          void stop("handoff").catch((error: unknown) => {
            console.error("run hand-off failed", ctx.runId, publicError(error).message);
          });
        },
        Math.max(0, slice.handoffAt - now()),
      );
      timer.unref();
    }
    const result = await options.runner({
      runId: ctx.runId,
      missionId: options.missionId,
      input: options.input,
      emit,
      signal,
      scope: { workspaceId: ctx.workspaceId, userId: ctx.userId },
      ...(options.resumeFrom === undefined ? {} : { resumeFrom: options.resumeFrom }),
      ...(options.connections === undefined ? {} : { connections: options.connections }),
      planApprover:
        options.autoApprovePlan === true
          ? { type: "system", id: "auto-approve" }
          : { type: "guest", id: ctx.userId },
      awaitPlanApproval:
        options.awaitPlanApproval ??
        createPlanApprovalWaiter({
          app,
          ctx,
          autoApprove: options.autoApprovePlan ?? false,
          ...options.planWait,
          ...(options.lease === undefined ? {} : { park }),
        }),
      ...(options.missionId === SHIP_MISSION_ID
        ? { awaitShipApproval: options.awaitShipApproval ?? createShipApprovalWaiter({ app, ctx }) }
        : {}),
      ...(options.findInstallation === undefined
        ? {}
        : { findInstallation: options.findInstallation }),
    });
    if (!progress.terminal && !signal.aborted && progress.stopped === null) {
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
    if (
      !progress.terminal &&
      !signal.aborted &&
      progress.stopped === null &&
      !(error instanceof RunAlreadyTerminalError)
    ) {
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
    if (timer !== undefined) clearTimeout(timer);
    registry.unregister(ctx.runId);
  }
}
