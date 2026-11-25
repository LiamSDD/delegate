import { describe, expect, it } from "vitest";

import {
  buildItRequest,
  gapSeverity,
  type NextAction,
  sortGapsBySeverity,
  type Gap,
} from "./m3-contract";

const action = (overrides: Partial<NextAction> = {}): NextAction => ({
  id: "build-opp-1",
  label: "Build it",
  missionId: "build-agent",
  available: true,
  opportunityId: "opp-1",
  input: {
    url: "https://acme.com/",
    goal: "Answer billing questions",
    name: "Billing helper",
    opportunityId: "opp-1",
    fromAuditRunId: "run-a",
  },
  ...overrides,
});

describe("buildItRequest", () => {
  it("turns an available build action into a build-agent run request with its parent", () => {
    expect(buildItRequest(action(), "11111111-1111-4111-8111-111111111111")).toEqual({
      missionId: "build-agent",
      input: {
        url: "https://acme.com/",
        goal: "Answer billing questions",
        name: "Billing helper",
        opportunityId: "opp-1",
      },
      parentRunId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("refuses unavailable, foreign or incomplete actions", () => {
    expect(buildItRequest(action({ available: false }), "p")).toBeNull();
    expect(buildItRequest(action({ missionId: "automation-audit" }), "p")).toBeNull();
    expect(buildItRequest(action({ input: { url: "https://acme.com/" } }), "p")).toBeNull();
  });
});

const gap = (id: string, kind: Gap["kind"]): Gap => ({
  id,
  kind,
  topic: id,
  detail: "detail",
  evidence: [],
  suggestion: "",
});

describe("gap severity", () => {
  it("ranks contradictions and failed evals above unanswerable and thin coverage", () => {
    expect(gapSeverity("contradiction")).toBe("high");
    expect(gapSeverity("failed_eval")).toBe("high");
    expect(gapSeverity("unanswerable")).toBe("medium");
    expect(gapSeverity("thin_coverage")).toBe("low");
    const sorted = sortGapsBySeverity([
      gap("a", "thin_coverage"),
      gap("b", "unanswerable"),
      gap("c", "contradiction"),
      gap("d", "thin_coverage"),
      gap("e", "failed_eval"),
    ]);
    expect(sorted.map((entry) => entry.id)).toEqual(["c", "e", "b", "a", "d"]);
  });
});
