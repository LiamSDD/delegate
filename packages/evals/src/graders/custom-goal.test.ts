import {
  defaultGoalPlan,
  type GoalBrief,
  parseRunEvent,
  type RunEvent,
  type RunEventDraft,
} from "@delegate/runtime";
import { describe, expect, it } from "vitest";

import {
  customGoalDatasetPath,
  loadCustomGoalDataset,
  parseCustomGoalDataset,
} from "../datasets/custom-goal";
import { gradeCustomGoal, gradePlan, targetParseMatches } from "./custom-goal";

const AT = "2026-11-25T10:00:00.000Z";
const cases = loadCustomGoalDataset();

function caseById(id: string) {
  const found = cases.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`missing case ${id}`);
  return found;
}

const brief: GoalBrief = {
  missionId: "custom-goal",
  status: "complete",
  goal: "I want to achieve nike's marketing and agentic work",
  objective: "Grow marketing reach and automate repetitive work with agents.",
  company: {
    name: "Nike, Inc.",
    url: "https://www.nike.com/",
    resolvedBy: "wikidata",
    entity: "Q483915",
  },
  workstreams: [
    { name: "Marketing", findings: [{ text: "Nike sells footwear.", citations: ["S1"] }] },
  ],
  actions: [1, 2, 3].map((rank) => ({
    rank,
    score: 1,
    title: `Action ${String(rank)}`,
    owner: "Head of Marketing",
    effort: "medium" as const,
    impact: "medium" as const,
    mission: null,
    basis: { text: "Nike sells footwear.", citations: ["S1"] },
  })),
  risks: [],
  openQuestions: [],
  sources: [
    {
      sourceId: "S1",
      url: "https://www.nike.com/",
      title: "Nike",
      kind: "company_site",
      fetchedAt: AT,
      quotes: ["footwear"],
    },
  ],
  sourceMix: { company_site: 1, wikipedia: 0, wikidata: 0, github: 0, feed: 0, connector: 0 },
  rankFormula: "score = impact ÷ effort",
  generatedAt: AT,
  promptVersions: [],
};

function log(drafts: Omit<RunEventDraft, "runId">[]): RunEvent[] {
  return drafts.map((draft, index) =>
    parseRunEvent({ ...draft, runId: "run_eval", seq: index + 1, at: AT }),
  );
}

function runLog(content: unknown, steps = defaultGoalPlan(true)): RunEvent[] {
  return log([
    {
      type: "run.created",
      payload: {
        workspaceId: "w",
        missionId: "custom-goal",
        input: { goal: brief.goal },
        actor: { type: "system", id: "eval" },
        budget: { maxTokens: 1, maxMicroUsd: 0 },
      },
    },
    { type: "plan.proposed", payload: { version: 1, steps, source: "default" } },
    {
      type: "artifact.created",
      payload: { artifactId: "a1", kind: "goal-brief", title: "Goal brief", version: 1, content },
    },
    { type: "run.completed", payload: { summary: "done" } },
  ]);
}

describe("custom-goal dataset v2", () => {
  it("has eight varied cases whose company expectations match the deterministic parser", () => {
    expect(cases.map((entry) => entry.id)).toEqual([
      "marketing-brand-possessive",
      "ops-invoice-domain",
      "engineering-no-company",
      "sales-playbook-domain",
      "brand-only-lowercase",
      "vague-ai",
      "support-response-domain",
      "hr-brand-only",
    ]);
    for (const entry of cases) {
      expect([entry.id, targetParseMatches(entry)]).toEqual([entry.id, true]);
      expect([entry.id, entry.expected.verification !== undefined]).toEqual([
        entry.id,
        entry.expected.target.kind !== "none",
      ]);
    }
  });

  it("keeps v1 loadable for results that reference it", () => {
    expect(loadCustomGoalDataset(customGoalDatasetPath("v1.jsonl"))).toHaveLength(6);
  });

  it("rejects malformed and duplicate lines", () => {
    const line = JSON.stringify({ ...caseById("vague-ai") });
    expect(() => parseCustomGoalDataset(`${line}\n${line}`)).toThrow(/Duplicate/);
    expect(() => parseCustomGoalDataset('{"id":"x"}')).toThrow(/invalid/);
  });
});

describe("gradeCustomGoal", () => {
  it("passes a completed run with a valid plan, cited claims and an owned action plan", () => {
    const grade = gradeCustomGoal(caseById("brand-only-lowercase"), runLog(brief));
    expect(grade.checks.filter((check) => !check.pass)).toEqual([]);
    expect(grade.passedHard).toBe(true);
    expect(grade.score).toBe(1);
  });

  it("fails uncited claims, thin action plans, wrong targets and invalid plans", () => {
    const uncited = {
      ...brief,
      company: null,
      actions: brief.actions.slice(0, 1),
      risks: [{ text: "Unsourced.", citations: ["S9"] }],
    };
    const grade = gradeCustomGoal(caseById("brand-only-lowercase"), runLog(uncited));
    const failed = grade.checks.filter((check) => !check.pass).map((check) => check.check);
    expect(failed).toEqual(["claims_cited", "action_plan_present", "target_resolved"]);
    expect(grade.passedHard).toBe(false);

    const short = defaultGoalPlan(false).slice(0, 2);
    expect(gradePlan(short)).toMatchObject({ pass: false });
    expect(gradePlan([{ ...defaultGoalPlan(false)[0], id: "scrape_google" }])).toMatchObject({
      pass: false,
    });
    expect(gradeCustomGoal(caseById("vague-ai"), runLog({ nope: true })).passedHard).toBe(false);
  });
});
