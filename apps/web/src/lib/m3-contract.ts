export {
  ANSWER_LIMITS,
  type AnswerEvent,
  ASSISTANT_EVALS_KIND,
  ASSISTANT_KIND,
  type AssistantArtifact,
  AssistantArtifactSchema,
  type AssistantEvals,
  AssistantEvalsSchema,
  type AssistantRecord,
  AssistantRecordSchema,
  type ChatTurn,
  ChatTurnSchema,
  type CitationRef,
  type CorpusStats,
  CRAWL_REPORT_KIND,
  type EvalCase,
  type EvalResult,
  GAPS_REPORT_KIND,
  type Gap,
  type GapsReport,
  GapsReportSchema,
  type NextAction,
  type RefusalReason,
} from "@delegate/runtime";

import type { Gap, NextAction } from "@delegate/runtime";

import type { StartRunRequest } from "./runs/start-run";

export const BUILD_AGENT_MISSION_ID = "build-agent";

export type GapSeverity = "high" | "medium" | "low";

const SEVERITY: Record<Gap["kind"], GapSeverity> = {
  contradiction: "high",
  failed_eval: "high",
  unanswerable: "medium",
  thin_coverage: "low",
};
const SEVERITY_RANK: Record<GapSeverity, number> = { high: 0, medium: 1, low: 2 };

export function gapSeverity(kind: Gap["kind"]): GapSeverity {
  return SEVERITY[kind];
}

export function sortGapsBySeverity(gaps: readonly Gap[]): Gap[] {
  return gaps
    .map((gap, index) => ({ gap, index }))
    .sort(
      (a, b) =>
        SEVERITY_RANK[gapSeverity(a.gap.kind)] - SEVERITY_RANK[gapSeverity(b.gap.kind)] ||
        a.index - b.index,
    )
    .map((entry) => entry.gap);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export function buildItRequest(action: NextAction, parentRunId: string): StartRunRequest | null {
  if (!action.available || action.missionId !== BUILD_AGENT_MISSION_ID) return null;
  const url = text(action.input.url);
  const goal = text(action.input.goal);
  if (url === undefined || goal === undefined) return null;
  const name = text(action.input.name);
  const opportunityId = text(action.input.opportunityId) ?? action.opportunityId;
  return {
    missionId: "build-agent",
    input: {
      url,
      goal,
      ...(name === undefined ? {} : { name }),
      ...(opportunityId === undefined ? {} : { opportunityId }),
    },
    parentRunId,
  };
}
