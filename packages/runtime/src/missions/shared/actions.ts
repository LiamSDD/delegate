export const ACTION_LIMITS = {
  minFirstStepWords: 4,
} as const;

const MISSION_NAMES =
  "(?:delegate['’]?s?\\s+)?(?:company[- ]?x[- ]?ray|(?:ai\\s+)?automation[- ]?audit|repo(?:sitory)?[- ]?x[- ]?ray|build[- ]?(?:an?\\s+)?agent|ship[- ]?a[- ]?pr|x[- ]?ray|audit)";

const MISSION_ONLY = new RegExp(
  `^(?:run|do|perform|execute|start|launch|use|try|conduct|kick off|initiate)\\s+(?:an?\\s+|the\\s+)?${MISSION_NAMES}(?:\\s+(?:mission|analysis|report))?(?:\\s+(?:on|for|of|at|about)\\s+(?:the\\s+)?(?:[\\p{L}\\p{N}.&'’,-]+\\s*){1,3})?[.!]?$`,
  "iu",
);

const MEASURABLE =
  /\p{N}|%|\b(?:per|rate|ratio|share|time|hours?|days?|weeks?|months?|minutes?|count|number|volume|conversion|retention|churn|nps|csat|revenue|cost|savings?|reduc\w*|increas\w*|decreas\w*|cut|grow\w*|within|from\s.+\sto)\b/iu;

const VAGUE_STEP =
  /^(?:explore|investigate|look into|research|consider|think about|evaluate options|assess|review|analy[sz]e|understand|learn more|figure out)(?:\s+(?:the|our|its|their|options|possibilities|opportunities|ways|how|whether))?[\s.]*$/iu;

export interface ActionShape {
  title: string;
  firstStep?: string | undefined;
  successMetric?: string | undefined;
}

export function namesOnlyAMission(title: string): boolean {
  return MISSION_ONLY.test(title.trim());
}

export function isMeasurable(metric: string): boolean {
  return MEASURABLE.test(metric);
}

export function checkActionConcreteness(action: ActionShape): string[] {
  const reasons: string[] = [];
  if (namesOnlyAMission(action.title))
    reasons.push("only says to run a mission, without a specific scope from the evidence");
  const step = action.firstStep?.trim() ?? "";
  const words = step.split(/\s+/).filter((word) => word !== "").length;
  if (step === "") reasons.push("has no first concrete step");
  else if (words < ACTION_LIMITS.minFirstStepWords || VAGUE_STEP.test(step))
    reasons.push("its first step is too vague to start on");
  else if (step.toLowerCase() === action.title.trim().toLowerCase())
    reasons.push("its first step only repeats the title");
  const metric = action.successMetric?.trim() ?? "";
  if (metric === "") reasons.push("has no success metric");
  else if (!isMeasurable(metric)) reasons.push("its success metric is not measurable");
  return reasons;
}
