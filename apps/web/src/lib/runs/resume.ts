import { foldRun, type RunEvent } from "@delegate/runtime";

export const LEASE_TTL_MS = 30_000;
export const MAX_RESUMES = 2;
export const MAX_RESUME_AGE_MS = 30 * 60_000;
export const RESUME_POLICY_ID = "durable-resume";
export const RESUME_TOOL = "run.resume";

const RESUMABLE_MISSIONS: ReadonlySet<string> = new Set([
  "company-xray",
  "automation-audit",
  "build-agent",
  "ship-a-pr",
  "repo-xray",
  "custom-goal",
]);

export const HANDOFF_POLICY_ID = "durable-yield";
export const HANDOFF_TOOL = "run.yield";
export const MAX_HANDOFFS = 12;

export type PlanWait = "pending" | "due";

export interface ResumeCandidate {
  terminal: boolean;
  execution: "live" | "simulated";
  mission: string;
  leaseExpiresAt: Date | null;
  lastEventAt: Date | null;
  createdAt: Date;
  activeHere: boolean;
  resumes: number;
  handedOff?: boolean;
  planWait?: PlanWait;
}

export type ResumeDecision = "none" | "resume" | "continue" | "sweep";

function continuable(run: ResumeCandidate): boolean {
  return run.execution === "live" && RESUMABLE_MISSIONS.has(run.mission);
}

export function resumeDecision(run: ResumeCandidate, now: Date): ResumeDecision {
  if (run.terminal || run.activeHere) return "none";
  const leased = run.leaseExpiresAt !== null && run.leaseExpiresAt.getTime() > now.getTime();
  if (leased) return "none";
  if (run.planWait === "pending") return "none";
  if (run.handedOff === true) return continuable(run) ? "continue" : "none";
  if (run.planWait === "due") return continuable(run) ? "continue" : "sweep";
  if (run.leaseExpiresAt === null) {
    const quietFor = now.getTime() - (run.lastEventAt ?? run.createdAt).getTime();
    if (quietFor <= LEASE_TTL_MS) return "none";
  }
  if (run.execution !== "live" || !RESUMABLE_MISSIONS.has(run.mission)) return "sweep";
  if (run.resumes >= MAX_RESUMES) return "sweep";
  if (now.getTime() - run.createdAt.getTime() > MAX_RESUME_AGE_MS) return "sweep";
  return "resume";
}

export function resumeMarkerDraft(progress: { skipped: number; rerun: number }) {
  const kept = `${String(progress.skipped)} completed step${progress.skipped === 1 ? "" : "s"} kept`;
  const rerun = `${String(progress.rerun)} to run`;
  return {
    type: "policy.decided" as const,
    payload: {
      tool: RESUME_TOOL,
      decision: "allow" as const,
      policyId: RESUME_POLICY_ID,
      reason: `Worker lost (server restart); resumed from the event log: ${kept}, ${rerun}.`,
    },
  };
}

export interface ResumeNotice {
  at: string;
  reason: string;
}

export function resumeNotices(events: readonly RunEvent[]): ResumeNotice[] {
  return events.flatMap((event) =>
    event.type === "policy.decided" && event.payload.policyId === RESUME_POLICY_ID
      ? [{ at: event.at, reason: event.payload.reason }]
      : [],
  );
}

export function handoffMarkerDraft(progress: { elapsedMs: number; budgetMs: number }) {
  const elapsed = Math.round(progress.elapsedMs / 1_000);
  const budget = Math.round(progress.budgetMs / 1_000);
  return {
    type: "policy.decided" as const,
    payload: {
      tool: HANDOFF_TOOL,
      decision: "allow" as const,
      policyId: HANDOFF_POLICY_ID,
      reason: `Planned hand-off: this server invocation was ${String(elapsed)} s into its ${String(budget)} s limit. Completed steps are kept and the run continues in a new invocation.`,
    },
  };
}

export function isHandoffMarker(event: Pick<RunEvent, "type" | "payload">): boolean {
  return (
    event.type === "policy.decided" &&
    (event.payload as { policyId?: unknown }).policyId === HANDOFF_POLICY_ID
  );
}

export function endedWithHandoff(events: readonly Pick<RunEvent, "type" | "payload">[]): boolean {
  const last = events.at(-1);
  return last !== undefined && isHandoffMarker(last);
}

export function countHandoffs(events: readonly Pick<RunEvent, "type" | "payload">[]): number {
  return events.filter(isHandoffMarker).length;
}

export function stalledHandoffs(events: readonly Pick<RunEvent, "type" | "payload">[]): number {
  let stalled = 0;
  let progressed = false;
  let seenMarker = false;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined) continue;
    if (isHandoffMarker(event)) {
      if (seenMarker) {
        if (progressed) return stalled;
        stalled += 1;
      }
      seenMarker = true;
      progressed = false;
      continue;
    }
    if (event.type === "step.completed" || event.type === "plan.approved") progressed = true;
  }
  return stalled;
}

export function awaitingPlanApproval(events: readonly RunEvent[]): boolean {
  try {
    const state = foldRun(events);
    if (state.status === "completed" || state.status === "failed") return false;
    return state.plan !== null && !state.plan.approved;
  } catch {
    return false;
  }
}
