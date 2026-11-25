import { describe, expect, it } from "vitest";

import { type SpecificityContext, type SpecificitySource } from "../../agent/specificity";
import { goalActionFeedback, groundGoalSections, redraftKeepsActions } from "./grounding";
import { GOAL_MIN_ACTIONS, normaliseGoalSynthesis, type GoalSynthesisOutput } from "./schema";

const action = (title: string, basis: string, citations: string[], extra: object = {}) => ({
  title,
  owner: "Head of Engineering",
  effort: "low",
  impact: "high",
  mission: null,
  basis: { text: basis, citations },
  firstStep: "List the ten slowest CI jobs from the last 30 days of runs",
  successMetric: "Cut median CI time from 25 to 15 minutes within a quarter",
  ...extra,
});

function ground(raw: GoalSynthesisOutput, context: SpecificityContext) {
  const evidence = new Set(context.sources.keys());
  const normalised = normaliseGoalSynthesis(raw, evidence);
  const grounded = groundGoalSections(normalised.sections, context);
  return { normalised, grounded };
}

describe("goal action grounding feedback (gate run, 2026-11-25)", () => {
  const reference = (title: string): SpecificitySource => ({
    kind: "wikipedia",
    title,
    url: `https://en.wikipedia.org/wiki/${title.replace(/ /g, "_")}`,
  });

  it("topic-only goal: names the action whose basis is a definition and asks for a concrete practice", () => {
    const context: SpecificityContext = {
      target: { names: [] },
      sources: new Map([
        ["S1", reference("Flaky test")],
        ["S2", reference("Continuous integration")],
      ]),
    };
    const raw: GoalSynthesisOutput = {
      objective: "Reduce flaky tests and speed up CI for an open-source monorepo",
      workstreams: [],
      actions: [
        action(
          "Quarantine tests that fail and pass on the same commit",
          "Google reported that 16% of its tests showed some flakiness, so re-run detection finds them.",
          ["S1"],
        ),
        action(
          "Audit Playwright test suite for flaky tests and slow CI runs",
          "A flaky test is a test that both passes and fails on the same code.",
          ["S1"],
        ),
        action("Cache dependencies between CI runs", "Caching restores dependencies.", ["S9"]),
        { title: "Split the CI pipeline", owner: "Head of Engineering" },
      ],
      risks: [],
      openQuestions: [],
      context: [],
    };
    const { normalised, grounded } = ground(raw, context);
    expect(grounded.sections.actions).toHaveLength(1);
    const feedback = goalActionFeedback(normalised, grounded, context, GOAL_MIN_ACTIONS);
    expect(feedback).toContain(`1 grounded action was kept; return ${GOAL_MIN_ACTIONS} to 8`);
    expect(feedback).toContain("Audit Playwright test suite");
    expect(feedback).toContain("defines a generic concept");
    expect(feedback).toContain("Cache dependencies between CI runs");
    expect(feedback).toContain("S9");
    expect(feedback).toContain("Split the CI pipeline");
    expect(feedback).toMatch(/firstStep/);
    expect(feedback).toMatch(/concrete practice, figure or example/);
  });

  it("company goal: lists the sources about the target when actions cite only reference articles", () => {
    const context: SpecificityContext = {
      target: { names: ["Patagonia"] },
      sources: new Map<string, SpecificitySource>([
        [
          "S1",
          { kind: "company_site", title: "Our footprint", url: "https://brand.example/footprint" },
        ],
        ["S2", { kind: "company_site", title: "Privacy", url: "https://brand.example/privacy" }],
        ["S4", reference("Influencer marketing")],
        ["S5", reference("Digital marketing")],
      ]),
    };
    const raw: GoalSynthesisOutput = {
      objective: "Grow Patagonia's brand marketing in Europe without paid social",
      workstreams: [],
      actions: [
        action(
          "Define a European influencer and creator partnership programme",
          "One estimate links a 1% increase in influencer spending to a 0.5% rise in engagement.",
          ["S4"],
        ),
        action(
          "Plan non-social European brand media placements",
          "Digital marketing extends to television, SMS and on-hold ringtones.",
          ["S5"],
        ),
      ],
      risks: [],
      openQuestions: [],
      context: [],
    };
    const { normalised, grounded } = ground(raw, context);
    expect(grounded.sections.actions).toHaveLength(0);
    const feedback = goalActionFeedback(normalised, grounded, context, GOAL_MIN_ACTIONS);
    expect(feedback).toContain("sourced only from general reference articles");
    expect(feedback).toContain("Sources about Patagonia: S1, S2");
  });

  it("asks for nothing once enough actions are grounded", () => {
    const context: SpecificityContext = {
      target: { names: [] },
      sources: new Map([["S1", reference("Flaky test")]]),
    };
    const concrete = (title: string) =>
      action(title, "Google reported that 16% of its tests showed some flakiness.", ["S1"]);
    const { normalised, grounded } = ground(
      {
        objective: "Reduce flaky tests",
        workstreams: [],
        actions: [
          concrete("Quarantine flaky tests"),
          concrete("Retry once"),
          concrete("Track flake rate"),
        ],
        risks: [],
        openQuestions: [],
        context: [],
      },
      context,
    );
    expect(goalActionFeedback(normalised, grounded, context, GOAL_MIN_ACTIONS)).toBeUndefined();
  });
});

describe("redraftKeepsActions", () => {
  it("rejects a deep-research redraft that loses actions below the minimum", () => {
    expect(redraftKeepsActions(3, 2)).toBe(false);
    expect(redraftKeepsActions(5, 3)).toBe(true);
    expect(redraftKeepsActions(1, 1)).toBe(true);
    expect(redraftKeepsActions(0, 0)).toBe(true);
  });
});
