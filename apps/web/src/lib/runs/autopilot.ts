import {
  AUTOPILOT_REPORT_KIND,
  type AutopilotLink,
  type AutopilotReport,
  AutopilotReportSchema,
  type ChildRunState,
  foldRun,
  plannedNodes,
  type RunEvent,
  type RunState,
  trackOf,
} from "@delegate/runtime";
import { z } from "zod";

export type NodeTone = "neutral" | "accent" | "success" | "warning" | "danger";

export type NodeStatus =
  | "queued"
  | "planning"
  | "awaiting_plan_approval"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed";

export interface GraphNode {
  nodeId: string;
  missionId: string;
  label: string;
  runId: string | null;
  status: NodeStatus;
  summary: string | null;
  metrics: { label: string; value: string }[];
  links: { label: string; href: string }[];
  handoff: string | null;
  approvals: ChildRunState["approvals"] | null;
}

export const NODE_STATUS: Record<NodeStatus, { label: string; tone: NodeTone; live: boolean }> = {
  queued: { label: "Queued", tone: "neutral", live: false },
  planning: { label: "Planning", tone: "accent", live: true },
  awaiting_plan_approval: { label: "Plan needs approval", tone: "warning", live: false },
  running: { label: "Running", tone: "accent", live: true },
  awaiting_approval: { label: "Needs approval", tone: "warning", live: false },
  completed: { label: "Done", tone: "success", live: false },
  failed: { label: "Failed", tone: "danger", live: false },
};

const NODE_STATUSES = Object.keys(NODE_STATUS) as NodeStatus[];

export const LiveChildrenSchema = z.object({
  children: z.array(z.object({ childRunId: z.uuid().nullable(), status: z.string() }).loose()),
});

export type LiveStatuses = Readonly<Record<string, string>>;

export function liveStatuses(body: unknown): LiveStatuses {
  const parsed = LiveChildrenSchema.safeParse(body);
  if (!parsed.success) return {};
  return Object.fromEntries(
    parsed.data.children.flatMap((child) =>
      child.childRunId === null ? [] : [[child.childRunId, child.status]],
    ),
  );
}

function nodeStatus(value: string | undefined, fallback: NodeStatus): NodeStatus {
  return NODE_STATUSES.find((status) => status === value) ?? fallback;
}

export function foldSafely(events: readonly RunEvent[]): RunState | null {
  try {
    return events.length === 0 ? null : foldRun(events);
  } catch {
    return null;
  }
}

function handoffLabel(child: ChildRunState): string | null {
  if (child.from === undefined) return null;
  return child.from.itemTitle === undefined
    ? child.from.contract
    : `${child.from.contract}: ${child.from.itemTitle}`;
}

export function autopilotNodes(state: RunState, live: LiveStatuses = {}): GraphNode[] {
  const terminal = state.status === "completed" || state.status === "failed";
  const started = new Map(state.children.map((child) => [child.nodeId, child]));
  const nodes: GraphNode[] = [];
  for (const planned of plannedNodes(trackOf(state.children))) {
    const child = started.get(planned.nodeId);
    if (child === undefined) {
      if (terminal) continue;
      nodes.push({
        nodeId: planned.nodeId,
        missionId: planned.missionId,
        label: planned.label,
        runId: null,
        status: "queued",
        summary: null,
        metrics: [],
        links: [],
        handoff: null,
        approvals: null,
      });
      continue;
    }
    const outcome = child.outcome;
    nodes.push({
      nodeId: child.nodeId,
      missionId: child.missionId,
      label: child.label,
      runId: child.childRunId,
      status:
        outcome === undefined
          ? nodeStatus(live[child.childRunId], terminal ? "failed" : "planning")
          : outcome.status,
      summary: outcome?.summary ?? null,
      metrics: outcome?.metrics ?? [],
      links: outcome?.links.filter((link) => link.href !== `/runs/${child.childRunId}`) ?? [],
      handoff: handoffLabel(child),
      approvals: child.approvals,
    });
  }
  return nodes;
}

export function autopilotReport(events: readonly RunEvent[]): AutopilotReport | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "artifact.created" || event.payload.kind !== AUTOPILOT_REPORT_KIND)
      continue;
    const parsed = AutopilotReportSchema.safeParse(event.payload.content);
    return parsed.success ? parsed.data : null;
  }
  return null;
}

export function autopilotParent(events: readonly RunEvent[]): AutopilotLink | null {
  const created = events[0];
  return created?.type === "run.created" ? (created.payload.autopilot ?? null) : null;
}

export function autopilotGoal(events: readonly RunEvent[]): string | null {
  const created = events[0];
  if (created?.type !== "run.created") return null;
  const goal = created.payload.input.goal;
  return typeof goal === "string" && goal !== "" ? goal : null;
}

export function formatMinutes(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes < 1 ? "under a minute" : `${String(minutes)} min`;
}

export function approvalNote(approvals: ChildRunState["approvals"] | null): string | null {
  if (approvals === null) return null;
  const plan = approvals.plan === "auto" ? "plan auto-approved" : "plan waits for you";
  const effects =
    approvals.sideEffects === "patch_only"
      ? "patch only"
      : approvals.sideEffects === "ask"
        ? "side effects ask first"
        : "read-only";
  return `${plan} · ${effects}`;
}
