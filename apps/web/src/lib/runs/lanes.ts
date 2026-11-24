import type { AgentRole, ModelRole, RunEvent } from "@delegate/runtime";

import { type ActivityItem, buildActivity } from "./run-view";

export type LaneStatus = "running" | "done" | "failed";

export interface Lane {
  id: string;
  stepId: string | null;
  role: AgentRole | null;
  modelRole: ModelRole | null;
  model: string | null;
  status: LaneStatus;
  startedAt: string;
  endedAt: string | null;
  items: ActivityItem[];
  flags: number;
}

export const RUN_LANE = "run";

export function buildLanes(events: readonly RunEvent[]): Lane[] {
  const lanes = new Map<string, Lane>();
  const latestAgentOfStep = new Map<string, string>();
  const laneOfSeq = new Map<number, string>();
  const terminal = events.find(
    (event) => event.type === "run.completed" || event.type === "run.failed",
  );

  for (const event of events) {
    if (event.type === "agent.spawned") {
      lanes.set(event.agentId, {
        id: event.agentId,
        stepId: event.stepId,
        role: event.payload.role,
        modelRole: event.payload.modelRole,
        model: null,
        status: "running",
        startedAt: event.at,
        endedAt: null,
        items: [],
        flags: 0,
      });
      latestAgentOfStep.set(event.stepId, event.agentId);
    }
    let laneId = RUN_LANE;
    if (event.agentId !== undefined && lanes.has(event.agentId)) laneId = event.agentId;
    else if (event.stepId !== undefined) laneId = latestAgentOfStep.get(event.stepId) ?? RUN_LANE;
    laneOfSeq.set(event.seq, laneId);
    const lane = lanes.get(laneId);
    if (event.type === "usage.updated" && lane !== undefined) {
      lane.model = `${event.payload.provider} · ${event.payload.model}`;
    }
    if (event.type === "step.completed") {
      for (const candidate of lanes.values()) {
        if (candidate.stepId === event.stepId && candidate.status === "running") {
          candidate.status = event.payload.outcome === "succeeded" ? "done" : "failed";
          candidate.endedAt = event.at;
        }
      }
    }
  }
  if (terminal !== undefined) {
    for (const lane of lanes.values()) {
      if (lane.status === "running") {
        lane.status = terminal.type === "run.completed" ? "done" : "failed";
        lane.endedAt = terminal.at;
      }
    }
  }

  const runLane: Lane = {
    id: RUN_LANE,
    stepId: null,
    role: null,
    modelRole: null,
    model: null,
    status:
      terminal === undefined ? "running" : terminal.type === "run.completed" ? "done" : "failed",
    startedAt: events[0]?.at ?? new Date(0).toISOString(),
    endedAt: terminal?.at ?? null,
    items: [],
    flags: 0,
  };
  for (const item of buildActivity(events)) {
    const lane = lanes.get(laneOfSeq.get(item.seq) ?? RUN_LANE) ?? runLane;
    lane.items.push(item);
    if (item.kind === "flag") lane.flags += 1;
  }
  const result = [...lanes.values()];
  if (runLane.items.length > 0) result.push(runLane);
  return result;
}
