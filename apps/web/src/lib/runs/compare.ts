import type { RunEvent } from "@delegate/runtime";

import { parseAudit } from "./audit";
import { type Brief, orderedSections, parseBrief, sectionRows } from "./brief";
import { type ClaimChange, type ClaimRef, diffClaims } from "./claim-diff";
import { forkInfo, type ForkInfo } from "./fork";
import { buildRunView, type OutcomeKind, type RunView } from "./run-view";
import { citationRate, sourceCount } from "./summary";

type ReadyView = Extract<RunView, { ok: true }>;

export interface RunMetrics {
  runId: string;
  missionId: string;
  target: string | null;
  execution: "live" | "simulated";
  outcome: OutcomeKind | null;
  durationMs: number | null;
  stepsDone: number;
  stepsTotal: number;
  models: string[];
  inputTokens: number;
  outputTokens: number;
  citationAccuracy: number | null;
  sources: number | null;
  fork: ForkInfo | null;
}

export function briefClaims(brief: Brief): ClaimRef[] {
  return orderedSections(brief).flatMap(({ title, section }) =>
    sectionRows(section).map((row) => ({ section: title, label: row.label, text: row.claim.text })),
  );
}

export function auditClaims(content: unknown): ClaimRef[] | null {
  const parsed = parseAudit(content);
  if (!parsed.ok) return null;
  return [
    { section: "Summary", text: parsed.audit.summary },
    ...parsed.audit.opportunities.flatMap((opportunity) =>
      opportunity.evidence.map((evidence) => ({
        section: opportunity.title,
        label: opportunity.department,
        text: evidence.text,
      })),
    ),
  ];
}

export function claimsOf(view: ReadyView): ClaimRef[] | null {
  if (view.audit?.content !== undefined && view.audit.content !== null)
    return auditClaims(view.audit.content);
  if (view.brief?.content !== undefined && view.brief.content !== null) {
    const parsed = parseBrief(view.brief.content);
    return parsed.ok ? briefClaims(parsed.brief) : null;
  }
  return null;
}

export function runMetrics(
  runId: string,
  view: ReadyView,
  events: readonly RunEvent[],
): RunMetrics {
  return {
    runId,
    missionId: view.missionId,
    target: view.target,
    execution: view.execution,
    outcome: view.outcome?.kind ?? null,
    durationMs:
      view.finishedAt === null ? null : Date.parse(view.finishedAt) - Date.parse(view.createdAt),
    stepsDone: view.stepsDone,
    stepsTotal: view.steps.length,
    models: [
      ...new Set(view.modelMix.filter((entry) => entry.calls > 0).map((entry) => entry.model)),
    ],
    inputTokens: view.usage.inputTokens,
    outputTokens: view.usage.outputTokens,
    citationAccuracy: citationRate(view.citation),
    sources: sourceCount(view, events),
    fork: forkInfo(events),
  };
}

export type RunComparison =
  | {
      ok: true;
      a: RunMetrics;
      b: RunMetrics;
      claims: ClaimChange[] | null;
      sameMission: boolean;
    }
  | { ok: false; error: string };

export function compareRuns(
  a: { runId: string; events: readonly RunEvent[] },
  b: { runId: string; events: readonly RunEvent[] },
): RunComparison {
  const left = buildRunView(a.events);
  const right = buildRunView(b.events);
  if (!left.ok) return { ok: false, error: `Run A: ${left.error}` };
  if (!right.ok) return { ok: false, error: `Run B: ${right.error}` };
  const leftClaims = claimsOf(left);
  const rightClaims = claimsOf(right);
  return {
    ok: true,
    a: runMetrics(a.runId, left, a.events),
    b: runMetrics(b.runId, right, b.events),
    claims:
      leftClaims === null || rightClaims === null ? null : diffClaims(leftClaims, rightClaims),
    sameMission: left.missionId === right.missionId,
  };
}
