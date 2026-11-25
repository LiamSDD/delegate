import {
  classifyClaim,
  sourceAboutTarget,
  specificityScore,
  type SpecificityContext,
  type SpecificityScore,
} from "../../agent/specificity";
import { type Claim } from "../company-xray/brief";
import { checkActionConcreteness } from "../shared/actions";
import { CONTEXT_LINES, GOAL_MIN_ACTIONS, type GoalSections, type NormalisedGoal } from "./schema";

export interface GroundingDrop {
  where: string;
  text: string;
  reason: string;
}

export interface GroundedGoal {
  sections: GoalSections;
  dropped: GroundingDrop[];
  score: SpecificityScore;
}

export function groundGoalSections(
  sections: GoalSections,
  context: SpecificityContext,
): GroundedGoal {
  const dropped: GroundingDrop[] = [];
  const contextLines: Claim[] = [...(sections.context ?? [])].slice(0, CONTEXT_LINES);
  let specific = 0;
  let generic = 0;
  const route = (claim: Claim, where: string): Claim | null => {
    const verdict = classifyClaim(claim, context);
    if (verdict.label === "specific") {
      specific += 1;
      return claim;
    }
    generic += 1;
    if (contextLines.length < CONTEXT_LINES) contextLines.push(claim);
    else
      dropped.push({
        where,
        text: claim.text,
        reason: `Generic background (${verdict.reasons.join("; ")}); the context note already has ${CONTEXT_LINES} lines`,
      });
    return null;
  };
  const workstreams = sections.workstreams.flatMap((stream) => {
    const findings = stream.findings.flatMap((claim) => route(claim, stream.name) ?? []);
    return findings.length === 0 ? [] : [{ ...stream, findings }];
  });
  const risks = sections.risks.flatMap((claim) => route(claim, "risks") ?? []);
  const actions = sections.actions
    .flatMap((action) => {
      const reasons = checkActionConcreteness(action);
      const basis = classifyClaim(action.basis, context);
      if (basis.label === "generic")
        reasons.push(`its evidence is generic background (${basis.reasons.join("; ")})`);
      if (reasons.length === 0) {
        specific += 1;
        return [action];
      }
      if (basis.label === "generic") generic += 1;
      dropped.push({
        where: `action: ${action.title}`,
        text: action.title,
        reason: `Action removed: it ${reasons.join("; ")}`,
      });
      return [];
    })
    .map((action, index) => ({ ...action, rank: index + 1 }));
  const movedToContext = Math.max(0, contextLines.length - (sections.context?.length ?? 0));
  return {
    sections: {
      workstreams,
      actions,
      risks,
      openQuestions: sections.openQuestions,
      context: contextLines,
    },
    dropped,
    score: specificityScore(specific, generic, Math.min(generic, movedToContext)),
  };
}

export function goalActionFeedback(
  normalised: NormalisedGoal,
  grounded: GroundedGoal,
  context: SpecificityContext,
  minimum: number,
): string | undefined {
  const kept = grounded.sections.actions.length;
  if (kept >= minimum) return undefined;
  const lines = [
    `- ${kept} grounded action${kept === 1 ? " was" : "s were"} kept; return ${minimum} to 8 actions, each with title, owner, effort, impact, mission, basis {text, citations}, firstStep and successMetric.`,
    ...normalised.actionIssues.map(
      (issue) => `- Discarded ${JSON.stringify(issue.title)}: ${issue.reason}`,
    ),
    ...normalised.dropped
      .filter((entry) => entry.where.startsWith("action: "))
      .map(
        (entry) =>
          `- Discarded ${JSON.stringify(entry.where.slice("action: ".length))}: its basis cites ${entry.claim.citations.join(", ") || "nothing"}, which is not a source id with extracted facts`,
      ),
    ...grounded.dropped
      .filter((entry) => entry.where.startsWith("action: "))
      .map(
        (entry) =>
          `- Rejected ${JSON.stringify(entry.text)}: ${entry.reason.replace(/^Action removed: it /, "it ")}`,
      ),
  ];
  const names = context.target.names.filter((name) => name.trim() !== "");
  if (names.length > 0) {
    const about = [...context.sources.entries()]
      .filter(([, source]) => sourceAboutTarget(source, context.target))
      .map(([id]) => id);
    lines.push(
      about.length > 0
        ? `- Sources about ${names[0] ?? "the target"}: ${about.slice(0, 12).join(", ")}. Each basis cites at least one of them and says what it shows about ${names[0] ?? "the target"}; general reference articles may only be cited alongside one.`
        : `- No source is about ${names[0] ?? "the target"} itself; base actions on findings that name it, and put what is missing into openQuestions.`,
    );
  } else
    lines.push(
      "- No company is given: each basis states a concrete practice, figure or example from the cited fact (who does what, a number, a named tool), never a definition.",
    );
  return lines.slice(0, 24).join("\n");
}

export function redraftKeepsActions(current: number, redrafted: number): boolean {
  return redrafted >= Math.min(current, GOAL_MIN_ACTIONS);
}
