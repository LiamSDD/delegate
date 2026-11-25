import { type ChildHandoff, type ChildRunState } from "../../events";
import { GOAL_BRIEF_KIND, GoalBriefSchema } from "../custom-goal/schema";
import {
  auditInputFromXray,
  BRIEF_NODE,
  briefInput,
  buildInputFromAudit,
  chooseTrack,
  shipInputFromXray,
  TRACK_NODES,
  type AutopilotNode,
  type ChildArtifacts,
  type HandoffResult,
} from "./chain";
import {
  type AutopilotInput,
  type AutopilotLimits,
  type AutopilotReport,
  type AutopilotReportStep,
  type AutopilotStopReason,
  type AutopilotTier,
  type AutopilotTrack,
  AUTOPILOT_MISSION_ID,
} from "./schema";

export interface AutopilotStop {
  reason: AutopilotStopReason;
  message: string;
}

export type AutopilotMove =
  | {
      kind: "start";
      node: AutopilotNode;
      input: Record<string, unknown>;
      from?: ChildHandoff;
      track: AutopilotTrack | null;
    }
  | {
      kind: "finish";
      status: AutopilotReport["status"];
      track: AutopilotTrack | null;
      stop: AutopilotStop | null;
      note?: string;
    };

export interface AutopilotProgress {
  input: AutopilotInput;
  children: readonly ChildRunState[];
  artifacts: (childRunId: string) => ChildArtifacts | undefined;
  tokens: number;
  elapsedMs: number;
  limits: AutopilotLimits;
  shipAvailable: boolean;
}

export function trackOf(children: readonly ChildRunState[]): AutopilotTrack | null {
  const first = children[1];
  if (first === undefined) return null;
  return TRACK_NODES.repo.some((node) => node.nodeId === first.nodeId) ? "repo" : "company";
}

export function plannedNodes(track: AutopilotTrack | null): AutopilotNode[] {
  if (track === null || track === "brief-only") return [BRIEF_NODE];
  return [BRIEF_NODE, ...TRACK_NODES[track]];
}

function briefObjective(artifacts: ChildArtifacts | undefined): string | null {
  const parsed = GoalBriefSchema.safeParse(artifacts?.get(GOAL_BRIEF_KIND)?.content);
  return parsed.success ? parsed.data.objective : null;
}

function budgetStop(progress: AutopilotProgress): AutopilotStop | null {
  const { limits } = progress;
  if (progress.children.length >= limits.maxChildren)
    return {
      reason: "max_children",
      message: `Stopped after ${String(limits.maxChildren)} child runs, the most one Autopilot run may launch.`,
    };
  if (progress.tokens >= limits.maxTokens)
    return {
      reason: "token_cap",
      message: `Stopped before the next step: child runs used ${progress.tokens.toLocaleString("en-US")} tokens of the ${limits.maxTokens.toLocaleString("en-US")}-token Autopilot cap.`,
    };
  if (progress.elapsedMs >= limits.maxWallMs)
    return {
      reason: "wall_time",
      message: `Stopped before the next step: the ${String(Math.round(limits.maxWallMs / 60_000))}-minute Autopilot time limit was reached.`,
    };
  return null;
}

function handoffFor(
  node: AutopilotNode,
  previous: ChildRunState,
  progress: AutopilotProgress,
): HandoffResult {
  const artifacts = progress.artifacts(previous.childRunId) ?? new Map();
  switch (node.nodeId) {
    case "audit": {
      const brief = progress.children[0];
      return auditInputFromXray(
        previous.childRunId,
        previous.input,
        artifacts,
        brief === undefined ? null : briefObjective(progress.artifacts(brief.childRunId)),
      );
    }
    case "build":
      return buildInputFromAudit(previous.childRunId, previous.input, artifacts);
    case "ship":
      return shipInputFromXray(previous.childRunId, artifacts);
    default:
      return { ok: false, message: `No hand-off is defined into ${node.label}.` };
  }
}

export function nextAutopilotMove(progress: AutopilotProgress): AutopilotMove {
  const { children } = progress;
  if (children.some((child) => child.outcome === undefined))
    throw new Error("nextAutopilotMove needs every started child to have finished");
  const last = children.at(-1);
  if (last === undefined) {
    const stop = budgetStop(progress);
    if (stop !== null) return { kind: "finish", status: "stopped", track: null, stop };
    return { kind: "start", node: BRIEF_NODE, input: briefInput(progress.input), track: null };
  }
  const track = trackOf(children);
  if (last.outcome?.status === "failed")
    return {
      kind: "finish",
      status: "failed",
      track,
      stop: {
        reason: "child_failed",
        message:
          `${last.label} failed, so Autopilot stopped: ${last.outcome.error?.message ?? last.outcome.summary}`.slice(
            0,
            400,
          ),
      },
    };

  let node: AutopilotNode;
  let handoff: HandoffResult;
  let chosen: AutopilotTrack | null = track;
  if (last.nodeId === BRIEF_NODE.nodeId) {
    const choice = chooseTrack(last.childRunId, progress.artifacts(last.childRunId) ?? new Map());
    if (!choice.ok)
      return {
        kind: "finish",
        status: "failed",
        track: null,
        stop: { reason: "handoff_failed", message: choice.message },
      };
    if (choice.track === "brief-only")
      return {
        kind: "finish",
        status: "completed",
        track: "brief-only",
        stop: null,
        note: choice.reason,
      };
    chosen = choice.track;
    const first = TRACK_NODES[choice.track][0];
    if (first === undefined) throw new Error(`Track ${choice.track} has no nodes`);
    node = first;
    handoff = { ok: true, handoff: choice.handoff };
  } else {
    const nodes = chosen === null || chosen === "brief-only" ? [] : TRACK_NODES[chosen];
    const index = nodes.findIndex((entry) => entry.nodeId === last.nodeId);
    const following = nodes[index + 1];
    if (following === undefined)
      return { kind: "finish", status: "completed", track: chosen, stop: null };
    node = following;
    handoff = handoffFor(node, last, progress);
  }

  const stop = budgetStop(progress);
  if (stop !== null) return { kind: "finish", status: "stopped", track: chosen, stop };
  if (!handoff.ok)
    return {
      kind: "finish",
      status: "failed",
      track: chosen,
      stop: { reason: "handoff_failed", message: handoff.message },
    };
  if (node.missionId === "ship-a-pr" && !progress.shipAvailable)
    return {
      kind: "finish",
      status: "stopped",
      track: chosen,
      stop: {
        reason: "unavailable",
        message:
          "Ship-a-PR is not available on this deployment (it needs the live runtime and DELEGATE_SHIP_A_PR=1); the chosen improvement can be shipped from the Repo X-ray run.",
      },
    };
  return {
    kind: "start",
    node,
    input: handoff.handoff.input,
    ...(handoff.handoff.from === undefined ? {} : { from: handoff.handoff.from }),
    track: chosen,
  };
}

export interface ReportArgs {
  input: AutopilotInput;
  tier: AutopilotTier;
  children: readonly ChildRunState[];
  finish: Extract<AutopilotMove, { kind: "finish" }>;
  tokens: number;
  elapsedMs: number;
  limits: AutopilotLimits;
  now: Date;
}

function headlineFor(args: ReportArgs, completed: number, planned: number): string {
  const lead = `${String(completed)} of ${String(planned)} step${planned === 1 ? "" : "s"} done`;
  const last = args.children.findLast((child) => child.outcome?.status === "completed");
  const detail = last?.outcome?.summary ?? "";
  if (args.finish.status === "completed") return `${lead}. ${detail}`.trim().slice(0, 400);
  return `${lead}. ${args.finish.stop?.message ?? ""}`.trim().slice(0, 400);
}

export function buildAutopilotReport(args: ReportArgs): AutopilotReport {
  const nodes = plannedNodes(args.finish.track);
  const started = new Map(args.children.map((child) => [child.nodeId, child]));
  const steps: AutopilotReportStep[] = nodes.map((node) => {
    const child = started.get(node.nodeId);
    if (child === undefined)
      return {
        nodeId: node.nodeId,
        missionId: node.missionId,
        label: node.label,
        childRunId: null,
        status: "not_started",
        outcome: null,
        ...(args.finish.stop === null ? {} : { note: args.finish.stop.message }),
      };
    return {
      nodeId: child.nodeId,
      missionId: child.missionId,
      label: child.label,
      childRunId: child.childRunId,
      status: child.outcome?.status ?? "failed",
      outcome: child.outcome ?? null,
      ...(child.from === undefined ? {} : { from: child.from }),
    };
  });
  const needsHuman = [
    ...args.children.flatMap((child) => child.outcome?.needsHuman ?? []),
    ...(args.finish.stop === null || args.finish.stop.reason === "child_failed"
      ? []
      : [args.finish.stop.message]),
    ...(args.finish.note === undefined ? [] : [args.finish.note]),
  ];
  const completed = steps.filter((step) => step.status === "completed").length;
  return {
    missionId: AUTOPILOT_MISSION_ID,
    goal: args.input.goal,
    status: args.finish.status,
    headline: headlineFor(args, completed, steps.length),
    track: args.finish.track,
    tier: args.tier,
    steps,
    needsHuman: [...new Set(needsHuman)].slice(0, 12),
    stop: args.finish.stop,
    usage: {
      children: args.children.length,
      tokens: Math.max(0, Math.round(args.tokens)),
      wallMs: Math.max(0, Math.round(args.elapsedMs)),
    },
    limits: { ...args.limits },
    generatedAt: args.now.toISOString(),
  };
}
