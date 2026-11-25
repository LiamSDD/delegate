import type { RunEvent } from "@delegate/runtime";
import { describe, expect, it } from "vitest";

import {
  LEASE_TTL_MS,
  MAX_RESUME_AGE_MS,
  MAX_RESUMES,
  resumeDecision,
  resumeMarkerDraft,
  resumeNotices,
} from "./resume";

const now = new Date("2026-11-25T10:00:00.000Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

const base = {
  terminal: false,
  execution: "live" as const,
  mission: "build-agent",
  leaseExpiresAt: null as Date | null,
  lastEventAt: ago(1_000),
  createdAt: ago(60_000),
  activeHere: false,
  resumes: 0,
};

describe("resumeDecision", () => {
  it("leaves finished, local and leased runs alone", () => {
    expect(resumeDecision({ ...base, terminal: true }, now)).toBe("none");
    expect(resumeDecision({ ...base, activeHere: true, leaseExpiresAt: ago(1) }, now)).toBe("none");
    expect(resumeDecision({ ...base, leaseExpiresAt: new Date(now.getTime() + 5_000) }, now)).toBe(
      "none",
    );
  });

  it("resumes live runs whose lease expired or that never got one and went quiet", () => {
    expect(resumeDecision({ ...base, leaseExpiresAt: ago(1) }, now)).toBe("resume");
    expect(resumeDecision({ ...base, lastEventAt: ago(LEASE_TTL_MS + 1) }, now)).toBe("resume");
    expect(resumeDecision({ ...base, lastEventAt: ago(1_000) }, now)).toBe("none");
    for (const mission of ["custom-goal", "repo-xray"])
      expect(resumeDecision({ ...base, mission, leaseExpiresAt: ago(1) }, now)).toBe("resume");
  });

  it("hands runs that cannot be resumed to the stale sweeper", () => {
    const expired = { ...base, leaseExpiresAt: ago(1) };
    expect(resumeDecision({ ...expired, execution: "simulated" }, now)).toBe("sweep");
    expect(resumeDecision({ ...expired, mission: "unknown" }, now)).toBe("sweep");
    expect(resumeDecision({ ...expired, resumes: MAX_RESUMES }, now)).toBe("sweep");
    expect(resumeDecision({ ...expired, createdAt: ago(MAX_RESUME_AGE_MS + 1) }, now)).toBe(
      "sweep",
    );
  });
});

describe("resume notices", () => {
  it("are read back from the marker events in the log", () => {
    const draft = resumeMarkerDraft({ skipped: 3, rerun: 2 });
    const events = [
      {
        runId: "r",
        seq: 1,
        at: "2026-11-25T10:00:00.000Z",
        type: draft.type,
        payload: draft.payload,
      },
      {
        runId: "r",
        seq: 2,
        at: "2026-11-25T10:00:01.000Z",
        type: "policy.decided",
        payload: { tool: "web_fetch", decision: "allow", policyId: "baseline", reason: "ok" },
      },
    ] as RunEvent[];
    expect(resumeNotices(events)).toEqual([
      { at: "2026-11-25T10:00:00.000Z", reason: draft.payload.reason },
    ]);
    expect(draft.payload.reason).toContain("3 completed steps kept");
  });
});
