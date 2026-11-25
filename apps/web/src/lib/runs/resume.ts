import type { RunEvent } from "@delegate/runtime";

export const LEASE_TTL_MS = 30_000;
export const MAX_RESUMES = 2;
export const MAX_RESUME_AGE_MS = 30 * 60_000;
export const RESUME_POLICY_ID = "durable-resume";
export const RESUME_TOOL = "run.resume";

const RESUMABLE_MISSIONS: ReadonlySet<string> = new Set([
  "company-xray",
  "automation-audit",
  "build-agent",
  "repo-xray",
]);

export interface ResumeCandidate {
  terminal: boolean;
  execution: "live" | "simulated";
  mission: string;
  leaseExpiresAt: Date | null;
  lastEventAt: Date | null;
  createdAt: Date;
  activeHere: boolean;
  resumes: number;
}

export type ResumeDecision = "none" | "resume" | "sweep";

export function resumeDecision(run: ResumeCandidate, now: Date): ResumeDecision {
  if (run.terminal || run.activeHere) return "none";
  if (run.leaseExpiresAt !== null) {
    if (run.leaseExpiresAt.getTime() > now.getTime()) return "none";
  } else {
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
