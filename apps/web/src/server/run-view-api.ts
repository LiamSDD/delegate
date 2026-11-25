import { foldRun, MISSIONS, type RunState } from "@delegate/runtime";
import { type Artifact, type RunView } from "@delegate/sdk";

import type { AppDatabase } from "./db";
import { pendingPlanApproval, readPlanDecision } from "./plan-approval";
import { artifactContent, isTerminalEventType, readAllEvents, type RunRecord } from "./runs";

function deliverableKind(mission: string): string | undefined {
  const entry = (MISSIONS as Partial<Record<string, { deliverableKind: string }>>)[mission];
  return entry?.deliverableKind;
}

function foldSafely(events: Parameters<typeof foldRun>[0]): RunState | null {
  try {
    return events.length === 0 ? null : foldRun(events);
  } catch {
    return null;
  }
}

export async function buildRunView(
  app: AppDatabase,
  userId: string,
  record: RunRecord,
): Promise<RunView> {
  const state = foldSafely(await readAllEvents(app, userId, record.id));
  const terminal = record.lastEventType !== null && isTerminalEventType(record.lastEventType);
  const objectives = new Map((state?.plan?.steps ?? []).map((step) => [step.id, step.objective]));
  const steps = (state?.steps ?? []).map((step) => ({
    id: step.id,
    objective: objectives.get(step.id) ?? step.id,
    status: step.status,
    ...(step.summary === undefined ? {} : { summary: step.summary }),
  }));
  const artifacts = Object.values(state?.artifacts ?? {}).map((entry) => ({
    artifactId: entry.artifactId,
    kind: entry.kind,
    title: entry.title,
    version: entry.version,
  }));
  const kind = deliverableKind(record.mission);
  const finalRef =
    kind === undefined ? undefined : artifacts.findLast((entry) => entry.kind === kind);
  let deliverable: Artifact | null = null;
  if (finalRef !== undefined && record.status === "completed") {
    const content = await artifactContent(app, userId, record.id, finalRef.artifactId);
    if (content !== null)
      deliverable = {
        artifactId: content.artifactId,
        kind: content.kind,
        title: content.title,
        version: content.version,
        content: content.content,
      };
  }
  const folded = state?.status ?? record.status;
  const pending =
    folded === "awaiting_plan_approval" && !terminal
      ? await pendingPlanApproval(app, userId, record.id)
      : null;
  const status =
    folded === "awaiting_plan_approval" && pending === null
      ? (await readPlanDecision(app, userId, record.id)) === null
        ? "planning"
        : "running"
      : folded;
  return {
    id: record.id,
    mission: record.mission,
    status: terminal ? record.status : status,
    terminal,
    createdAt: record.createdAt.toISOString(),
    finishedAt: record.finishedAt?.toISOString() ?? null,
    totals: {
      inputTokens: record.totals.inputTokens,
      outputTokens: record.totals.outputTokens,
      costMicroUsd: record.totals.costMicroUsd,
      toolCalls: state?.totals.toolCalls ?? 0,
    },
    pendingPlan:
      pending !== null
        ? pending.steps.map((step) => ({
            id: step.id,
            objective: step.objective,
            status: "pending" as const,
          }))
        : null,
    pendingApprovals: (state?.pendingApprovals ?? []).map((approval) => ({
      approvalId: approval.approvalId,
      summary: approval.summary,
    })),
    steps,
    artifacts,
    deliverable,
    summary: state?.summary ?? null,
    error: state?.error ?? null,
  };
}
