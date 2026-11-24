import type { AppDatabase } from "./db";
import type { MissionRunner } from "./mission-runner";
import type { RunRegistry } from "./run-registry";
import {
  appendEvent,
  type EventDraft,
  isTerminalEventType,
  RunAlreadyTerminalError,
  type RunContext,
} from "./runs";

const MAX_ERROR_MESSAGE = 300;

function publicMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : "Unknown error";
  return text.length > MAX_ERROR_MESSAGE ? `${text.slice(0, MAX_ERROR_MESSAGE)}…` : text;
}

export interface ExecuteRunOptions {
  app: AppDatabase;
  ctx: RunContext;
  missionId: "company-xray";
  input: Record<string, unknown>;
  runner: MissionRunner;
  registry: RunRegistry;
}

export async function executeRun(options: ExecuteRunOptions): Promise<void> {
  const { app, ctx, registry } = options;
  const controller = registry.register(ctx.runId);
  const progress = { terminal: false };
  const emit = async (draft: EventDraft) => {
    if (progress.terminal) throw new RunAlreadyTerminalError(ctx.runId);
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
      signal: controller.signal,
    });
    if (!progress.terminal && !controller.signal.aborted) {
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
      !controller.signal.aborted &&
      !(error instanceof RunAlreadyTerminalError)
    ) {
      console.error("run failed", ctx.runId, error);
      await finish({
        type: "run.failed",
        payload: { error: { code: "runtime_error", message: publicMessage(error) } },
      });
    }
  } finally {
    registry.unregister(ctx.runId);
  }
}
