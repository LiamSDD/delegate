import { GoalBriefSchema, type RunEvent } from "@delegate/runtime";

import {
  CUSTOM_GOAL_DATASET,
  loadCustomGoalDataset,
  type CustomGoalCase,
} from "../datasets/custom-goal";
import { CUSTOM_GOAL_HARD_CHECKS, finalGoalBrief, gradeCustomGoal } from "../graders/custom-goal";
import {
  budgetChecks,
  hardFailuresOf,
  hygieneChecks,
  runMetrics,
  runOutcome,
  servingFrom,
  type GradedCheck,
} from "../graders/run-metrics";
import { rubricVerdictSchema } from "../judge/rubric-judge";
import { linkCheck, type MissionAdapter } from "./adapter";

export const GOAL_JUDGE_CRITERIA = [
  "relevance",
  "specificity",
  "actionability",
  "citationFaithfulness",
] as const;

export function goalCitedUrls(events: readonly RunEvent[]): string[] {
  const brief = GoalBriefSchema.safeParse(finalGoalBrief(events));
  if (!brief.success) return [];
  const cited = new Set(
    [
      ...brief.data.workstreams.flatMap((w) => w.findings),
      ...brief.data.actions.map((a) => a.basis),
      ...brief.data.risks,
    ].flatMap((claim) => claim.citations),
  );
  return [...new Set(brief.data.sources.filter((s) => cited.has(s.sourceId)).map((s) => s.url))];
}

export function renderGoalJudgeInput(evalCase: CustomGoalCase, deliverable: unknown): string {
  const brief = GoalBriefSchema.parse(deliverable);
  const claim = (c: { text: string; citations: readonly string[] }) =>
    `${c.text} [${c.citations.join(", ")}]`;
  const target = evalCase.expected.target;
  const lines = [
    `Goal: ${evalCase.input.goal}`,
    `Expected target: ${target.kind === "domain" ? target.host : target.kind === "brand" ? target.name : "none (topic only)"}`,
    `Workstream hints: ${evalCase.expected.workstreams.join(", ") || "none"}`,
    "",
    `Objective: ${brief.objective}`,
    `Company resolved: ${brief.company === null ? "none" : `${brief.company.name} (${brief.company.url}, via ${brief.company.resolvedBy})`}`,
    "",
    "## Findings",
  ];
  for (const stream of brief.workstreams)
    lines.push(`### ${stream.name}`, ...stream.findings.map((f) => `- ${claim(f)}`));
  lines.push(
    "",
    `## Actions (${brief.rankFormula})`,
    ...brief.actions.map(
      (a) =>
        `${a.rank}. ${a.title} — owner ${a.owner}, effort ${a.effort}, impact ${a.impact}${a.mission === null ? "" : `, follow-up ${JSON.stringify(a.mission)}`}; basis: ${claim(a.basis)}`,
    ),
    "",
    "## Risks",
    ...brief.risks.map((r) => `- ${claim(r)}`),
    "",
    "## Open questions",
    ...brief.openQuestions.map((q) => `- ${q}`),
    "",
    "## Sources and kept quotes",
  );
  for (const source of brief.sources) {
    lines.push(`[${source.sourceId}] ${source.url}`);
    for (const quote of source.quotes.slice(0, 4)) lines.push(`  > ${quote.slice(0, 200)}`);
  }
  return lines.join("\n");
}

const HARD: ReadonlySet<string> = new Set(CUSTOM_GOAL_HARD_CHECKS);

export const goalMission: MissionAdapter<CustomGoalCase, undefined> = {
  mission: "goal",
  title: "Custom goal",
  runtimeMissionId: "custom-goal",
  dataset: CUSTOM_GOAL_DATASET,
  loadCases: (path) => (path === undefined ? loadCustomGoalDataset() : loadCustomGoalDataset(path)),
  subject: (evalCase) => evalCase.input.goal,
  input: (evalCase) => evalCase.input,
  runtimePrompts: [
    "planner",
    "reader",
    "researcher",
    "goalSynthesis",
    "goalConnectors",
    "critic",
    "editor",
  ],
  defaultTargets: { maxLatencyMs: 240_000, maxCostMicroUsd: 0, maxTokens: 300_000 },
  hardDeadlineMs: 600_000,
  citedUrls: goalCitedUrls,
  grade({ evalCase, events, targets, links }) {
    const { outcome, failureCode } = runOutcome(events);
    const metrics = runMetrics(events);
    const grade = gradeCustomGoal(evalCase, events);
    const checks: GradedCheck[] = [
      ...grade.checks.map((c) => ({
        kind: c.check,
        severity: HARD.has(c.check) ? ("hard" as const) : ("soft" as const),
        passed: c.pass,
        detail: c.detail,
      })),
      linkCheck(goalCitedUrls(events), links),
      ...budgetChecks(metrics, targets),
      ...hygieneChecks(events, metrics),
    ];
    const brief = GoalBriefSchema.safeParse(finalGoalBrief(events));
    const cited = checks.find((c) => c.kind === "claims_cited");
    return {
      outcome,
      ...(failureCode === undefined ? {} : { failureCode }),
      checks,
      hardFailures: hardFailuresOf(outcome, checks),
      metrics,
      missionMetrics: brief.success
        ? {
            actions: brief.data.actions.length,
            findings: brief.data.workstreams.reduce((sum, w) => sum + w.findings.length, 0),
            sources: brief.data.sources.length,
            targetResolved:
              checks.find((c) => c.kind === "target_resolved")?.passed === true ? 1 : 0,
          }
        : {},
      serving: servingFrom(events),
      deliverable: finalGoalBrief(events),
      citationsVerified: outcome === "errored" || !brief.success ? null : cited?.passed === true,
    };
  },
  judge: {
    promptFile: "goal-judge.v1.md",
    criteria: GOAL_JUDGE_CRITERIA,
    schema: rubricVerdictSchema(GOAL_JUDGE_CRITERIA),
    render: (evalCase, deliverable) => renderGoalJudgeInput(evalCase, deliverable),
    ready: (grade) => grade.checks.some((c) => c.kind === "schema_valid" && c.passed),
  },
};
