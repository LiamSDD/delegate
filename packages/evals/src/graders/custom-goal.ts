import {
  analyseGoal,
  GOAL_BRIEF_KIND,
  GOAL_STEP_IDS,
  GOAL_STEP_LIMITS,
  GoalBriefSchema,
  PlanStepsSchema,
  type GoalBrief,
  type RunEvent,
} from "@delegate/runtime";

import { type CustomGoalCase, type ExpectedTarget } from "../datasets/custom-goal";

export const CUSTOM_GOAL_CHECKS = [
  "run_completed",
  "plan_valid",
  "schema_valid",
  "claims_cited",
  "action_plan_present",
  "target_resolved",
] as const;
export type CustomGoalCheck = (typeof CUSTOM_GOAL_CHECKS)[number];

export const CUSTOM_GOAL_HARD_CHECKS: readonly CustomGoalCheck[] = [
  "run_completed",
  "plan_valid",
  "schema_valid",
  "claims_cited",
  "action_plan_present",
];

const REQUIRED_STEPS = [
  GOAL_STEP_IDS.resolve,
  GOAL_STEP_IDS.topic,
  GOAL_STEP_IDS.synthesise,
  GOAL_STEP_IDS.critic,
];
const LIBRARY: ReadonlySet<string> = new Set(Object.values(GOAL_STEP_IDS));

export interface GoalCheckResult {
  check: CustomGoalCheck;
  pass: boolean;
  detail: string;
}

export interface CustomGoalGrade {
  caseId: string;
  checks: GoalCheckResult[];
  passedHard: boolean;
  score: number;
}

function result(check: CustomGoalCheck, pass: boolean, detail: string): GoalCheckResult {
  return { check, pass, detail };
}

export function latestPlan(events: readonly RunEvent[]): unknown {
  let steps: unknown;
  for (const event of events)
    if (event.type === "plan.proposed" || event.type === "plan.revised")
      steps = event.payload.steps;
  return steps;
}

export function gradePlan(raw: unknown): GoalCheckResult {
  const parsed = PlanStepsSchema.safeParse(raw);
  if (!parsed.success) return result("plan_valid", false, "No schema-valid plan in the log");
  const steps = parsed.data;
  const issues: string[] = [];
  if (steps.length < GOAL_STEP_LIMITS.min || steps.length > GOAL_STEP_LIMITS.max)
    issues.push(`${steps.length} steps, expected ${GOAL_STEP_LIMITS.min}–${GOAL_STEP_LIMITS.max}`);
  const ids = steps.map((step) => step.id);
  const unknown = ids.filter((id) => !LIBRARY.has(id));
  if (unknown.length > 0) issues.push(`steps outside the library: ${unknown.join(", ")}`);
  const missing = REQUIRED_STEPS.filter((id) => !ids.includes(id));
  if (missing.length > 0) issues.push(`missing required steps: ${missing.join(", ")}`);
  return result(
    "plan_valid",
    issues.length === 0,
    issues.length === 0 ? `${steps.length} valid steps` : issues.join("; "),
  );
}

export function finalGoalBrief(events: readonly RunEvent[]): unknown {
  const ids = new Set<string>();
  let content: unknown;
  for (const event of events) {
    if (event.type === "artifact.created" && event.payload.kind === GOAL_BRIEF_KIND) {
      ids.add(event.payload.artifactId);
      content = event.payload.content;
    }
    if (
      event.type === "artifact.updated" &&
      ids.has(event.payload.artifactId) &&
      event.payload.content !== undefined
    )
      content = event.payload.content;
  }
  return content;
}

export function gradeCitations(brief: GoalBrief): GoalCheckResult {
  const sources = new Set(brief.sources.map((source) => source.sourceId));
  const claims = [
    ...brief.workstreams.flatMap((stream) => stream.findings),
    ...brief.actions.map((action) => action.basis),
    ...brief.risks,
  ];
  const unresolved = claims.filter(
    (claim) =>
      claim.citations.length === 0 || claim.citations.some((sourceId) => !sources.has(sourceId)),
  );
  return result(
    "claims_cited",
    unresolved.length === 0,
    `${claims.length - unresolved.length}/${claims.length} claims cite resolvable sources`,
  );
}

export function gradeActions(brief: GoalBrief, minActions: number): GoalCheckResult {
  const complete = brief.actions.filter(
    (action) => action.owner.trim() !== "" && action.basis.citations.length > 0,
  );
  const ranked = brief.actions.every((action, index) => action.rank === index + 1);
  return result(
    "action_plan_present",
    complete.length >= minActions && ranked,
    `${complete.length} owned, cited actions (need ${minActions})${ranked ? "" : "; ranks are not 1..n"}`,
  );
}

function hostOf(url: string): string {
  return new URL(url).hostname.replace(/^www\./, "");
}

export function gradeTarget(brief: GoalBrief, expected: ExpectedTarget): GoalCheckResult {
  const company = brief.company;
  switch (expected.kind) {
    case "none":
      return result("target_resolved", company === null, company === null ? "none" : company.url);
    case "domain":
      return result(
        "target_resolved",
        company !== null && hostOf(company.url) === expected.host,
        company?.url ?? "none",
      );
    case "brand":
      return result(
        "target_resolved",
        company !== null && company.resolvedBy === "wikidata",
        company === null ? "none" : `${company.name} (${company.entity ?? "?"})`,
      );
  }
}

export function targetParseMatches(evalCase: CustomGoalCase): boolean {
  const target = analyseGoal(evalCase.input.goal);
  const expected = evalCase.expected.target;
  switch (expected.kind) {
    case "none":
      return target.domain === null && target.brands.length === 0;
    case "domain":
      return target.domain?.host === expected.host;
    case "brand":
      return (
        target.domain === null &&
        target.brands.some((brand) => brand.toLowerCase() === expected.name.toLowerCase())
      );
  }
}

export function gradeCustomGoal(
  evalCase: CustomGoalCase,
  events: readonly RunEvent[],
): CustomGoalGrade {
  const completed = events.at(-1)?.type === "run.completed";
  const checks: GoalCheckResult[] = [
    result("run_completed", completed, events.at(-1)?.type ?? "empty log"),
    gradePlan(latestPlan(events)),
  ];
  const parsed = GoalBriefSchema.safeParse(finalGoalBrief(events));
  if (!parsed.success) {
    checks.push(result("schema_valid", false, "No complete goal brief in the log"));
    for (const check of ["claims_cited", "action_plan_present", "target_resolved"] as const)
      checks.push(result(check, false, "No brief to grade"));
  } else {
    checks.push(result("schema_valid", true, "Complete goal brief"));
    checks.push(gradeCitations(parsed.data));
    checks.push(gradeActions(parsed.data, evalCase.expected.minActions));
    checks.push(gradeTarget(parsed.data, evalCase.expected.target));
  }
  const passedHard = checks
    .filter((check) => CUSTOM_GOAL_HARD_CHECKS.includes(check.check))
    .every((check) => check.pass);
  return {
    caseId: evalCase.id,
    checks,
    passedHard,
    score: checks.filter((check) => check.pass).length / checks.length,
  };
}
