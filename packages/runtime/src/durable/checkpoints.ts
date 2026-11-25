import { type ResumePoint } from "../agent/mission-runner";
import { SubAgentResultSchema, type SubAgentResult } from "../agent/subagent";
import { foldRun, type RunEvent } from "../events";

export interface ExistingArtifact {
  artifactId: string;
  kind: string;
  version: number;
  content: unknown;
  stepId?: string;
}

export type ResumeAnalysis =
  | { kind: "finished"; status: "completed" | "failed" }
  | {
      kind: "resumable";
      missionId: string;
      workspaceId: string;
      input: Record<string, unknown>;
      point?: ResumePoint;
      artifacts: ExistingArtifact[];
      completedSteps: string[];
      rerunSteps: string[];
    };

export function analyseForResume(events: readonly RunEvent[]): ResumeAnalysis {
  const state = foldRun(events);
  if (state.status === "completed" || state.status === "failed")
    return { kind: "finished", status: state.status };
  const created = events[0];
  if (created?.type !== "run.created")
    throw new Error("The event log does not start with run.created");
  const artifacts = new Map<string, ExistingArtifact>();
  const checkpoints = new Map<string, SubAgentResult>();
  const failed = new Set<string>();
  for (const event of events) {
    if (event.type === "artifact.created")
      artifacts.set(event.payload.artifactId, {
        artifactId: event.payload.artifactId,
        kind: event.payload.kind,
        version: event.payload.version,
        content: event.payload.content,
        ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
      });
    if (event.type === "artifact.updated") {
      const existing = artifacts.get(event.payload.artifactId);
      if (existing !== undefined)
        artifacts.set(event.payload.artifactId, {
          ...existing,
          version: event.payload.version,
          ...(event.payload.content === undefined ? {} : { content: event.payload.content }),
        });
    }
    if (event.type === "step.started") {
      checkpoints.delete(event.stepId);
      failed.delete(event.stepId);
    }
    if (event.type === "step.completed") {
      if (event.payload.outcome === "failed") failed.add(event.stepId);
      else {
        const parsed = SubAgentResultSchema.safeParse(event.payload.checkpoint);
        if (parsed.success) checkpoints.set(event.stepId, parsed.data);
      }
    }
  }
  const base = {
    kind: "resumable" as const,
    missionId: created.payload.missionId,
    workspaceId: created.payload.workspaceId,
    input: created.payload.input,
    artifacts: [...artifacts.values()],
  };
  if (state.plan === null) return { ...base, completedSteps: [], rerunSteps: [] };
  const planIds = new Set(state.plan.steps.map((step) => step.id));
  const completed = new Map([...checkpoints].filter(([id]) => planIds.has(id)));
  const failedInPlan = new Set([...failed].filter((id) => planIds.has(id)));
  return {
    ...base,
    point: {
      steps: state.plan.steps,
      version: state.plan.version,
      approved: state.plan.approved,
      completed,
      failed: failedInPlan,
    },
    completedSteps: [...completed.keys()],
    rerunSteps: state.plan.steps
      .map((step) => step.id)
      .filter((id) => !completed.has(id) && !failedInPlan.has(id)),
  };
}
