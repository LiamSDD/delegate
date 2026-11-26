import { describe, expect, it } from "vitest";

import { type CriticReport } from "../events";
import { type ModelRequest } from "../providers/types";
import { loadPrompt } from "../server";
import { scriptedProvider, testRun, textTurn } from "../testing/fakes";
import { formatAccuracy } from "./critic";
import {
  GoalCoverageOutputSchema,
  formatGoalCoverage,
  goalCoverageOf,
  goalCoverageUser,
  gradeGoalCoverage,
  needsMoreResearch,
} from "./goal-coverage";

const prompt = loadPrompt("goal-coverage.v1.md");

const REQUEST = {
  stepId: "critic",
  prompt,
  goal: "Which databases does Acme run in production, and why?",
  objective: "Summarise Acme's open-source footprint on GitHub.",
  sections: [
    {
      title: "GitHub activity",
      lines: ["Acme has 212 public repositories.", "Acme's top repository has 9,400 stars."],
    },
    { title: "Actions", lines: ["Publish a repository index: Acme has 212 repositories."] },
    { title: "Risks", lines: [] },
  ],
};

const OFF_TOPIC = {
  verdict: "not_answered",
  missing: ["databases Acme runs in production", "reasons Acme chose them"],
  reason: "The brief counts repositories and stars but never names a database.",
};

function userOf(request: ModelRequest | undefined): string {
  const content = request?.messages[0]?.content;
  return typeof content === "string" ? content : "";
}

describe("gradeGoalCoverage", () => {
  it("grades on the fast role with the versioned prompt and returns the verdict and missing aspects", async () => {
    const provider = scriptedProvider("fake", [textTurn(JSON.stringify(OFF_TOPIC))]);
    const result = await gradeGoalCoverage(testRun({ provider }).ctx, REQUEST);
    expect(result?.coverage).toEqual({
      verdict: "not_answered",
      missing: ["databases Acme runs in production", "reasons Acme chose them"],
      reason: "The brief counts repositories and stars but never names a database.",
      prompt: "goal-coverage@1",
    });
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.model).toBe("fake-fast");
    expect(provider.requests[0]?.system).toBe(prompt.body);
    const user = userOf(provider.requests[0]);
    expect(user).toContain(JSON.stringify(REQUEST.goal));
    expect(user).toContain("- Acme's top repository has 9,400 stars.");
    expect(user).toContain("### Risks\n- (empty)");
  });

  it("repairs one malformed answer, then gives up honestly instead of guessing", async () => {
    const repaired = scriptedProvider("fake", [
      textTurn('{"verdict":"maybe"}'),
      textTurn(JSON.stringify({ ...OFF_TOPIC, verdict: "partially" })),
    ]);
    const first = await gradeGoalCoverage(testRun({ provider: repaired }).ctx, REQUEST);
    expect(first?.coverage.verdict).toBe("partly");
    expect(first?.calls).toHaveLength(2);
    expect(userOf(repaired.requests[1])).toBe(userOf(repaired.requests[0]));
    expect(JSON.stringify(repaired.requests[1]?.messages)).toContain("failed validation");

    const broken = scriptedProvider("fake", [textTurn("no json"), textTurn('{"verdict":7}')]);
    expect(await gradeGoalCoverage(testRun({ provider: broken }).ctx, REQUEST)).toBeNull();
    expect(broken.requests).toHaveLength(2);
  });

  it("drops missing aspects from an answered verdict and caps the list", () => {
    const answered = GoalCoverageOutputSchema.parse({
      verdict: "Answered",
      missing: ["leftover"],
      reason: "All aspects are covered.",
    });
    expect(goalCoverageOf(prompt, answered)).toMatchObject({ verdict: "answered", missing: [] });
    const many = GoalCoverageOutputSchema.parse({
      verdict: "not answered",
      missing: Array.from({ length: 9 }, (_, index) => `aspect ${index % 8}`),
    });
    expect(goalCoverageOf(prompt, many)).toMatchObject({
      verdict: "not_answered",
      reason: "",
      missing: ["aspect 0", "aspect 1", "aspect 2", "aspect 3", "aspect 4", "aspect 5"],
    });
  });

  it("caps the deliverable it sends", () => {
    const user = goalCoverageUser({
      ...REQUEST,
      sections: [{ title: "Long", lines: Array.from({ length: 500 }, () => "x".repeat(300)) }],
    });
    expect(user.length).toBeLessThanOrEqual(6_000);
  });
});

describe("goal coverage in reports", () => {
  const report: CriticReport = {
    claimsChecked: 4,
    supported: 4,
    fixed: 0,
    weak: 0,
    removed: 0,
    unverified: 0,
    fixLoops: 0,
    citationAccuracy: 1,
    draftCitationAccuracy: 1,
  };

  it("puts goal coverage next to a perfect citation accuracy so 100% is not read as an answer", () => {
    const coverage = {
      verdict: "not_answered" as const,
      missing: OFF_TOPIC.missing,
      reason: OFF_TOPIC.reason,
      prompt: "goal-coverage@1",
    };
    expect(formatAccuracy({ ...report, goalCoverage: coverage })).toBe(
      "citation accuracy 100% (4/4; 0 fixed, 0 weak kept, 0 removed); goal coverage: not answered (missing: databases Acme runs in production; reasons Acme chose them)",
    );
    expect(formatAccuracy(report)).not.toContain("goal coverage");
    expect(formatGoalCoverage({ ...coverage, verdict: "answered", missing: [] })).toBe(
      "goal coverage: answered",
    );
    expect(needsMoreResearch(coverage)).toBe(true);
    expect(needsMoreResearch({ ...coverage, verdict: "answered", missing: [] })).toBe(false);
    expect(needsMoreResearch(undefined)).toBe(false);
  });
});
