import {
  classifyClaim,
  specificityScore,
  type SpecificityContext,
  type SpecificityScore,
} from "../../agent/specificity";
import { type Claim } from "../company-xray/brief";
import { checkActionConcreteness } from "../shared/actions";
import { CONTEXT_LINES, type GoalSections } from "./schema";

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
