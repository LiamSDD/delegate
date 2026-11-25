import { CAPABILITIES } from "@delegate/policy";

import { BudgetExceededError } from "../budget";
import {
  diffPlans,
  type Actor,
  type PlanPhase,
  type PlanStep,
  type PlaybookApplied,
} from "../events";
import { plannerGuidance, stepGuidance } from "../learning/playbook";
import { PlanApprovalDecisionSchema, type AwaitPlanApproval } from "../plan-approval";
import { type PromptFile } from "../prompts";
import { NoModelAvailableError } from "../router";
import { RunAbortedError, type RunContext } from "./context";
import {
  orchestrate,
  redact,
  type OrchestrationResult,
  type OrchestratorResume,
  type RevisionGate,
} from "./orchestrator";
import { chainHead, projectedCallMs, type MissionClock } from "./pacing";
import {
  checkPlanSteps,
  proposePlan,
  revisePlan,
  revisionApproval,
  type PlannerMission,
} from "./planner";
import { StructuredOutputError } from "./structured";
import { FatalStepError } from "./subagent";

export const PLANNER_MAX_CALL_MS = 15_000;

export const AUTO_APPROVER: Actor = { type: "system", id: "auto-approve" };
export const AUTO_APPROVAL_REASON =
  "Auto-approved by the system: no reviewer is attached to this run (evals, CLI or API without plan review).";
export const DEFAULT_PLAN_REVIEWER: Actor = { type: "member", id: "plan-reviewer" };

export interface MissionFailureInfo {
  code: string;
  message: string;
}

export type MissionFinish =
  { status: "completed"; summary: string } | { status: "failed"; error: MissionFailureInfo };

export interface PlannedMission {
  planner: PlannerMission;
  defaultPlan: readonly PlanStep[];
  clock: MissionClock;
  finish: (outcome: OrchestrationResult) => Promise<MissionFinish>;
  fixedPlan?: string;
}

export interface ResumePoint extends OrchestratorResume {
  steps: PlanStep[];
  phases?: PlanPhase[];
  version: number;
  approved: boolean;
}

export interface PlannedRunOptions {
  plannerPrompt: PromptFile;
  awaitPlanApproval?: AwaitPlanApproval;
  approver?: Actor;
  concurrency?: number;
  resume?: ResumePoint;
  playbook?: PlaybookApplied;
}

export function classifyFailure(error: unknown): MissionFailureInfo {
  if (error instanceof FatalStepError) return { code: error.code, message: redact(error.message) };
  if (error instanceof RunAbortedError)
    return { code: "cancelled", message: "The run was cancelled" };
  if (error instanceof BudgetExceededError)
    return { code: "budget_exceeded", message: redact(error.message) };
  if (error instanceof NoModelAvailableError)
    return {
      code: "no_model_available",
      message: redact(`Free model capacity is used up or unavailable right now. ${error.message}`),
    };
  if (error instanceof StructuredOutputError)
    return { code: "synthesis_invalid", message: redact(`${error.message}: ${error.issues}`) };
  return {
    code: "internal_error",
    message: redact(error instanceof Error ? error.message : "Unexpected failure"),
  };
}

export function stepFailure(outcome: OrchestrationResult, stepId: string): MissionFailureInfo {
  const cause = outcome.errors.get(stepId);
  return cause === undefined
    ? { code: "step_failed", message: `Step ${stepId} did not complete` }
    : classifyFailure(cause);
}

function plannerUsable(ctx: RunContext): { usable: boolean; reason?: string } {
  const head = chainHead(ctx, "planner");
  if (head === undefined)
    return { usable: false, reason: "No planner model is configured for this audience." };
  const ms = projectedCallMs(ctx, "planner");
  if (ms <= PLANNER_MAX_CALL_MS) return { usable: true };
  const rpm = head.provider.limits?.requestsPerMinute;
  return {
    usable: false,
    reason: `The planner model was skipped: ${head.provider.id} allows about ${rpm ?? "few"} calls per minute, so the mission's default plan is used to stay inside the time target.`,
  };
}

export async function runPlannedMission(
  ctx: RunContext,
  mission: PlannedMission,
  options: PlannedRunOptions,
): Promise<"completed" | "failed"> {
  const emit = ctx.emitter.emit.bind(ctx.emitter);
  const runId = ctx.runId;
  const fail = async (error: MissionFailureInfo) => {
    try {
      await ctx.emitter.flush().catch(() => undefined);
      await emit({ runId, type: "run.failed", payload: { error } });
      await ctx.emitter.flush();
    } catch {
      return "failed" as const;
    }
    return "failed" as const;
  };

  const playbook = options.playbook;
  const plannerMission: PlannerMission =
    playbook === undefined
      ? mission.planner
      : { ...mission.planner, guidance: plannerGuidance(playbook) };

  try {
    let version = 1;
    let steps: PlanStep[];
    let phases: PlanPhase[] | undefined;
    const resume = options.resume;
    if (resume === undefined) {
      if (playbook !== undefined)
        await emit({ runId, type: "playbook.applied", payload: playbook });
      const planner =
        mission.fixedPlan === undefined
          ? plannerUsable(ctx)
          : { usable: false, reason: mission.fixedPlan };
      const proposed = await proposePlan(ctx, {
        mission: plannerMission,
        defaultPlan: mission.defaultPlan,
        prompt: options.plannerPrompt,
        usePlanner: planner.usable,
        ...(planner.reason === undefined ? {} : { skipReason: planner.reason }),
      });
      steps = proposed.steps;
      phases = proposed.phases;
      const note =
        proposed.source === "default"
          ? `Using the mission's default plan. ${proposed.fallbackReason ?? ""}`.trim()
          : proposed.rationale;
      await emit({
        runId,
        type: "plan.proposed",
        payload: {
          version,
          steps,
          ...(phases === undefined ? {} : { phases }),
          source: proposed.source,
          ...(note === undefined ? {} : { rationale: note.slice(0, 2000) }),
        },
      });
      const first = steps[0];
      if (proposed.source === "default" && first !== undefined && note !== undefined) {
        await emit({
          runId,
          type: "agent.message",
          stepId: first.id,
          agentId: "planner",
          payload: { text: note },
        });
      }
      const ignored = ctx.quality?.ignoredReason;
      if (first !== undefined && ignored !== undefined)
        await emit({
          runId,
          type: "agent.message",
          stepId: first.id,
          agentId: "planner",
          payload: { text: ignored },
        });
    } else {
      version = resume.version;
      steps = resume.steps;
      phases = resume.phases;
    }

    if (resume?.approved === true) {
      steps = resume.steps;
    } else if (options.awaitPlanApproval === undefined) {
      await emit({
        runId,
        type: "plan.approved",
        payload: { version, approvedBy: AUTO_APPROVER, reason: AUTO_APPROVAL_REASON },
      });
    } else {
      const raw = await options.awaitPlanApproval(
        { version, steps: [...steps], kind: "initial" },
        ctx.signal,
      );
      const decision = PlanApprovalDecisionSchema.parse(raw);
      if (decision.decision === "rejected")
        return await fail({
          code: "plan_rejected",
          message: redact(decision.reason ?? "The plan was rejected by the reviewer"),
        });
      if (decision.steps !== undefined) {
        const checked = checkPlanSteps(decision.steps, mission.planner, phases);
        if (!checked.ok)
          return await fail({ code: "invalid_plan", message: redact(checked.issues.join("; ")) });
        const diff = diffPlans(steps, checked.steps);
        if (diff.added.length + diff.removed.length + diff.changed.length > 0) {
          version += 1;
          steps = checked.steps;
          await emit({
            runId,
            type: "plan.revised",
            payload: {
              version,
              steps,
              ...(phases === undefined ? {} : { phases }),
              reason: "Edited by the reviewer before approval",
              diff,
              source: "reviewer",
            },
          });
        }
      }
      await emit({
        runId,
        type: "plan.approved",
        payload: { version, approvedBy: options.approver ?? DEFAULT_PLAN_REVIEWER },
      });
    }

    let approvedSteps: readonly PlanStep[] = steps;
    const approver = options.approver ?? DEFAULT_PLAN_REVIEWER;
    const gate: RevisionGate = {
      requiresApproval: (revision) => revisionApproval(approvedSteps, revision.steps).required,
      approve: async (revision) => {
        const needed = revisionApproval(approvedSteps, revision.steps);
        const what = [
          ...(needed.addedCapabilities.length === 0
            ? []
            : [`adds capabilities ${needed.addedCapabilities.join(", ")}`]),
          ...(needed.sideEffectSteps.length === 0
            ? []
            : [`gives side effects to ${needed.sideEffectSteps.join(", ")}`]),
        ].join(" and ");
        if (options.awaitPlanApproval === undefined) {
          await emit({
            runId,
            type: "plan.approved",
            payload: {
              version: revision.version,
              approvedBy: AUTO_APPROVER,
              reason: `${AUTO_APPROVAL_REASON} The revision ${what}.`.slice(0, 900),
            },
          });
          approvedSteps = revision.steps;
          return true;
        }
        const raw = await options.awaitPlanApproval(
          {
            version: revision.version,
            steps: [...revision.steps],
            kind: "revision",
            required: needed.required,
          },
          ctx.signal,
        );
        const decision = PlanApprovalDecisionSchema.parse(raw);
        if (decision.decision === "rejected") return false;
        await emit({
          runId,
          type: "plan.approved",
          payload: {
            version: revision.version,
            approvedBy: approver,
            reason: `Re-approved: the revision ${what}.`.slice(0, 900),
          },
        });
        approvedSteps = revision.steps;
        return true;
      },
      restored: async (restoredVersion, rejected) => {
        await emit({
          runId,
          type: "plan.approved",
          payload: {
            version: restoredVersion,
            approvedBy: approver,
            reason: `Revision ${rejected} was not approved; this restores the plan approved earlier.`,
          },
        });
      },
    };

    mission.clock.restart();
    const outcome = await orchestrate(ctx, {
      plan: steps,
      ...(phases === undefined ? {} : { phases }),
      approveRevision: gate,
      version,
      executors: mission.planner.executors,
      ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
      ...(playbook === undefined
        ? {}
        : { guidance: (step: PlanStep) => stepGuidance(playbook, step, CAPABILITIES.webFetch) }),
      ...(resume === undefined
        ? {}
        : { resume: { completed: resume.completed, failed: resume.failed } }),
      replan: async (state) => {
        if (mission.fixedPlan !== undefined) return null;
        if (!plannerUsable(ctx).usable || !mission.clock.fits(["planner"])) return null;
        return revisePlan(ctx, { mission: plannerMission, prompt: options.plannerPrompt, state });
      },
    });
    if (outcome.fatal !== undefined) return await fail(classifyFailure(outcome.fatal));
    const finished = await mission.finish(outcome);
    if (finished.status === "failed") return await fail(finished.error);
    await emit({ runId, type: "run.completed", payload: { summary: finished.summary } });
    await ctx.emitter.flush();
    return "completed";
  } catch (error) {
    return fail(classifyFailure(error));
  }
}
