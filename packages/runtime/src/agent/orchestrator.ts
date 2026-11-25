import { BudgetExceededError } from "../budget";
import { diffPlans, type PlanStep } from "../events";
import { RunAbortedError, type RunContext } from "./context";
import { executorFor, type ReplanState, type StepStatusView } from "./planner";
import {
  FatalStepError,
  SubAgentResultSchema,
  type AgentHandle,
  type StepExecutor,
  type SubAgentResult,
} from "./subagent";

export const ORCHESTRATOR_DEFAULTS = {
  concurrency: 4,
  confidenceThreshold: 0.5,
  maxRevisions: 2,
  minStepShare: 0.05,
} as const;

const SECRET_PATTERN = /nvapi-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{10,}|Bearer\s+\S+/g;

export function redact(text: string): string {
  return text.replace(SECRET_PATTERN, "[redacted]").slice(0, 500);
}

export type Replanner = (
  state: ReplanState,
) => Promise<{ steps: PlanStep[]; reason: string } | null>;

export interface OrchestrateOptions {
  plan: readonly PlanStep[];
  version: number;
  executors: readonly StepExecutor[];
  concurrency?: number;
  confidenceThreshold?: number;
  maxRevisions?: number;
  replan?: Replanner;
  resume?: OrchestratorResume;
}

export interface OrchestratorResume {
  completed: ReadonlyMap<string, SubAgentResult>;
  failed: ReadonlySet<string>;
}

export class StepFailedBeforeResumeError extends Error {
  override readonly name = "StepFailedBeforeResumeError";
}

export interface OrchestrationResult {
  plan: PlanStep[];
  version: number;
  revisions: number;
  statuses: Map<string, StepStatusView>;
  results: Map<string, SubAgentResult>;
  errors: Map<string, unknown>;
  fatal?: unknown;
}

function isFatal(error: unknown): boolean {
  return (
    error instanceof RunAbortedError ||
    error instanceof FatalStepError ||
    (error instanceof BudgetExceededError && error.scope === "run")
  );
}

function ancestors(plan: readonly PlanStep[], stepId: string): string[] {
  const byId = new Map(plan.map((step) => [step.id, step]));
  const seen = new Set<string>();
  const stack = [...(byId.get(stepId)?.inputs ?? [])];
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined || seen.has(next)) continue;
    seen.add(next);
    stack.push(...(byId.get(next)?.inputs ?? []));
  }
  return plan.filter((step) => seen.has(step.id)).map((step) => step.id);
}

export async function orchestrate(
  ctx: RunContext,
  options: OrchestrateOptions,
): Promise<OrchestrationResult> {
  const concurrency = Math.max(1, options.concurrency ?? ORCHESTRATOR_DEFAULTS.concurrency);
  const threshold = options.confidenceThreshold ?? ORCHESTRATOR_DEFAULTS.confidenceThreshold;
  const maxRevisions = options.maxRevisions ?? ORCHESTRATOR_DEFAULTS.maxRevisions;
  const emit = ctx.emitter.emit.bind(ctx.emitter);
  const runId = ctx.runId;

  let plan = [...options.plan];
  let version = options.version;
  let revisions = 0;
  let replanAttempts = 0;
  const statuses = new Map<string, StepStatusView>(plan.map((step) => [step.id, "pending"]));
  const results = new Map<string, SubAgentResult>();
  const errors = new Map<string, unknown>();
  for (const step of plan) {
    const restored = options.resume?.completed.get(step.id);
    if (restored !== undefined) {
      statuses.set(step.id, "succeeded");
      results.set(step.id, restored);
    } else if (options.resume?.failed.has(step.id) === true) {
      statuses.set(step.id, "failed");
      errors.set(
        step.id,
        new StepFailedBeforeResumeError(`Step ${step.id} failed before the run was resumed`),
      );
    }
  }
  const running = new Map<string, Promise<void>>();
  const finished: string[] = [];
  let fatal: unknown;
  const stopped = () => fatal !== undefined;

  ctx.budget.allocate(plan, ORCHESTRATOR_DEFAULTS.minStepShare);

  const spawn = async (
    stepId: string,
    role: StepExecutor["role"],
    modelRole: StepExecutor["modelRole"],
  ): Promise<AgentHandle> => {
    const agentId = ctx.nextId(role);
    await emit({ runId, type: "agent.spawned", stepId, agentId, payload: { role, modelRole } });
    return {
      agentId,
      say: (text) => emit({ runId, type: "agent.message", stepId, agentId, payload: { text } }),
    };
  };

  const fail = async (step: PlanStep, summary: string, cause: unknown) => {
    statuses.set(step.id, "failed");
    errors.set(step.id, cause);
    await emit({
      runId,
      type: "step.completed",
      stepId: step.id,
      payload: { outcome: "failed", summary: redact(summary), artifactIds: [] },
    });
  };

  const execute = async (step: PlanStep, executor: StepExecutor) => {
    try {
      await emit({ runId, type: "step.started", stepId: step.id, payload: {} });
      const agent = await spawn(step.id, executor.role, executor.modelRole);
      const inputs = new Map<string, SubAgentResult>();
      for (const id of ancestors(plan, step.id)) {
        const result = results.get(id);
        if (result !== undefined) inputs.set(id, result);
      }
      const raw = await executor.run({
        step,
        grant: { id: step.id, capabilities: step.capabilities },
        agent,
        inputs,
        spawn: (role, modelRole) => spawn(step.id, role, modelRole),
      });
      const result = SubAgentResultSchema.parse(raw);
      results.set(step.id, result);
      statuses.set(step.id, "succeeded");
      await emit({
        runId,
        type: "step.completed",
        stepId: step.id,
        payload: {
          outcome: "succeeded",
          summary: result.summary,
          confidence: result.confidence,
          artifactIds: result.artifacts,
          ...(result.critic === undefined ? {} : { critic: result.critic }),
          checkpoint: result,
        },
      });
    } catch (error) {
      if (isFatal(error)) fatal ??= error;
      const message = error instanceof Error ? error.message : "Step failed";
      try {
        await fail(step, message, error);
      } catch (emitError) {
        fatal ??= emitError;
      }
    } finally {
      finished.push(step.id);
    }
  };

  const failedNeed = (step: PlanStep, executor: StepExecutor): string | undefined => {
    const needs = new Set(executor.needs ?? []);
    return ancestors(plan, step.id).find(
      (id) =>
        statuses.get(id) === "failed" && needs.has(executorFor(options.executors, id)?.id ?? ""),
    );
  };

  const maybeReplan = async (stepId: string) => {
    if (options.replan === undefined || replanAttempts >= maxRevisions) return;
    const status = statuses.get(stepId);
    const result = results.get(stepId);
    const reason =
      status === "failed"
        ? `Step failed: ${redact(errors.get(stepId) instanceof Error ? (errors.get(stepId) as Error).message : "unknown error")}`
        : result !== undefined && result.confidence < threshold && result.needsReplan !== undefined
          ? `Low confidence (${result.confidence.toFixed(2)}): ${result.needsReplan.reason}`
          : undefined;
    if (reason === undefined) return;
    if (!plan.some((step) => statuses.get(step.id) === "pending")) return;
    replanAttempts += 1;
    const revised = await options.replan({
      plan,
      version,
      statuses,
      results,
      trigger: { stepId, reason },
    });
    if (revised === null) return;
    const diff = diffPlans(plan, revised.steps);
    if (diff.added.length + diff.removed.length + diff.changed.length === 0) return;
    version += 1;
    revisions += 1;
    plan = revised.steps;
    for (const step of plan) if (!statuses.has(step.id)) statuses.set(step.id, "pending");
    for (const id of diff.removed) statuses.delete(id);
    ctx.budget.allocate(plan, ORCHESTRATOR_DEFAULTS.minStepShare);
    await emit({
      runId,
      type: "plan.revised",
      payload: { version, steps: plan, reason: revised.reason, diff, source: "planner" },
    });
  };

  for (;;) {
    if (fatal !== undefined) break;
    if (ctx.signal?.aborted === true) {
      fatal = new RunAbortedError();
      break;
    }
    while (finished.length > 0) {
      const stepId = finished.shift();
      if (stepId !== undefined && !stopped()) await maybeReplan(stepId);
    }
    for (const step of plan) {
      if (statuses.get(step.id) !== "pending") continue;
      const executor = executorFor(options.executors, step.id);
      if (executor === undefined) {
        await fail(
          step,
          `No executor for step ${step.id}`,
          new Error(`No executor for ${step.id}`),
        );
        continue;
      }
      const blocked = failedNeed(step, executor);
      if (blocked !== undefined)
        await fail(step, `Not run: needs ${blocked}, which failed`, errors.get(blocked));
    }
    const ready = plan.filter(
      (step) =>
        statuses.get(step.id) === "pending" &&
        step.inputs.every((input) => {
          const status = statuses.get(input);
          return status === "succeeded" || status === "failed";
        }),
    );
    for (const step of ready) {
      if (running.size >= concurrency) break;
      const executor = executorFor(options.executors, step.id);
      if (executor === undefined) continue;
      statuses.set(step.id, "running");
      const task = execute(step, executor).finally(() => running.delete(step.id));
      running.set(step.id, task);
    }
    if (running.size === 0) {
      if (finished.length > 0) continue;
      break;
    }
    await Promise.race(running.values());
  }
  await Promise.allSettled(running.values());
  return {
    plan,
    version,
    revisions,
    statuses,
    results,
    errors,
    ...(fatal === undefined ? {} : { fatal }),
  };
}
