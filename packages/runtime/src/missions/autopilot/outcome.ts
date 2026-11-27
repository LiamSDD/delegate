import { z } from "zod";

import { type ChildMissionId, type ChildOutcome, type RunEvent } from "../../events";
import { AUTOMATION_AUDIT_KIND, AutomationAuditSchema } from "../automation-audit/schema";
import { estimateRoi } from "../automation-audit/roi";
import { ASSISTANT_KIND, AssistantArtifactSchema } from "../build-agent/schema";
import { GOAL_BRIEF_KIND, type GoalBrief, GoalBriefSchema } from "../custom-goal/schema";
import { REPO_XRAY_KIND, RepoXraySchema } from "../repo-xray/schema";
import { SHIP_RESULT_KIND, ShipResultSchema } from "../ship-a-pr/schema";
import { childArtifacts, COMPANY_XRAY_BRIEF_KIND, type ChildArtifact } from "./chain";

export const CHILD_DELIVERABLE_KINDS: Record<ChildMissionId, string> = {
  "custom-goal": GOAL_BRIEF_KIND,
  "company-xray": COMPANY_XRAY_BRIEF_KIND,
  "automation-audit": AUTOMATION_AUDIT_KIND,
  "build-agent": ASSISTANT_KIND,
  "repo-xray": REPO_XRAY_KIND,
  "ship-a-pr": SHIP_RESULT_KIND,
};

type Metric = ChildOutcome["metrics"][number];
type Link = ChildOutcome["links"][number];

interface Details {
  metrics: Metric[];
  links: Link[];
  needsHuman: string[];
}

const none: Details = { metrics: [], links: [], needsHuman: [] };

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function metric(label: string, value: string | number): Metric {
  return { label: cut(label, 40), value: cut(String(value), 80) };
}

function percent(value: number): string {
  return `${String(Math.round(value * 100))}%`;
}

function eur(value: number): string {
  return `€${Math.round(value).toLocaleString("en-US")}/mo`;
}

const SourcesSchema = z.object({ sources: z.array(z.unknown()) });

export const BRIEF_QUALITY_GATE = { minCitationAccuracy: 0.7, maxWeakClaims: 5 } as const;

export function weakClaimCount(events: readonly RunEvent[]): number {
  return events.filter(
    (event) => event.type === "critic.flagged" && event.payload.claimId.endsWith(":weak"),
  ).length;
}

export function briefQualityFlags(brief: GoalBrief, weakClaims: number): string[] {
  const flags: string[] = [];
  const accuracy = brief.verification?.citationAccuracy;
  if (
    accuracy !== undefined &&
    accuracy !== null &&
    accuracy < BRIEF_QUALITY_GATE.minCitationAccuracy
  )
    flags.push(
      `The brief's citation accuracy is ${percent(accuracy)}, below the ${percent(BRIEF_QUALITY_GATE.minCitationAccuracy)} gate: check its claims before relying on the missions it fed.`,
    );
  if (weakClaims > BRIEF_QUALITY_GATE.maxWeakClaims)
    flags.push(
      `${String(weakClaims)} claims in the brief are only weakly supported by their sources (gate: ${String(BRIEF_QUALITY_GATE.maxWeakClaims)}).`,
    );
  const coverage = brief.verification?.goalCoverage;
  if (coverage !== undefined && coverage.verdict !== "answered")
    flags.push(
      cut(
        `The brief ${coverage.verdict === "partly" ? "only partly answers" : "does not answer"} the goal${coverage.missing.length === 0 ? "" : `; missing: ${coverage.missing.join("; ")}`}.`,
        300,
      ),
    );
  return flags;
}

function briefDetails(brief: GoalBrief, weakClaims: number): Details {
  const accuracy = brief.verification?.citationAccuracy;
  const coverage = brief.verification?.goalCoverage;
  return {
    metrics: [
      metric("Ranked actions", brief.actions.length),
      metric("Cited sources", brief.sources.length),
      ...(accuracy === undefined || accuracy === null
        ? []
        : [metric("Citation accuracy", percent(accuracy))]),
      ...(weakClaims === 0 ? [] : [metric("Weak claims", weakClaims)]),
      ...(coverage === undefined
        ? []
        : [metric("Goal coverage", coverage.verdict.replace("_", " "))]),
    ],
    links: [],
    needsHuman: briefQualityFlags(brief, weakClaims),
  };
}

function detailsFor(
  missionId: ChildMissionId,
  artifact: ChildArtifact,
  events: readonly RunEvent[],
): Details {
  switch (missionId) {
    case "custom-goal": {
      const brief = GoalBriefSchema.safeParse(artifact.content);
      if (!brief.success) return none;
      return briefDetails(brief.data, weakClaimCount(events));
    }
    case "company-xray": {
      const brief = SourcesSchema.safeParse(artifact.content);
      return brief.success
        ? { ...none, metrics: [metric("Cited sources", brief.data.sources.length)] }
        : none;
    }
    case "automation-audit": {
      const audit = AutomationAuditSchema.safeParse(artifact.content);
      if (!audit.success) return none;
      const top = audit.data.opportunities[0];
      return {
        metrics: [
          metric("Opportunities", audit.data.opportunities.length),
          ...(top === undefined ? [] : [metric("Top estimate", eur(estimateRoi(top).eurPerMonth))]),
        ],
        links: [],
        needsHuman: [],
      };
    }
    case "build-agent": {
      const assistant = AssistantArtifactSchema.safeParse(artifact.content);
      if (!assistant.success) return none;
      const { passRate, gapsCount } = assistant.data;
      return {
        metrics: [
          metric(
            "Self-test",
            passRate === null || passRate === undefined ? "not run" : percent(passRate),
          ),
          ...(gapsCount === undefined ? [] : [metric("Gaps", gapsCount)]),
          metric("Status", assistant.data.status),
        ],
        links: [{ label: "Open the assistant", href: `/agents/${assistant.data.id}` }],
        needsHuman: [
          ...(passRate === null || passRate === undefined
            ? ["The assistant's self-test did not produce a score; try it before sharing it."]
            : []),
          ...(gapsCount !== undefined && gapsCount > 0
            ? [
                `Review ${String(gapsCount)} gap${gapsCount === 1 ? "" : "s"} in the assistant's gaps report before putting it in front of customers.`,
              ]
            : []),
        ],
      };
    }
    case "repo-xray": {
      const xray = RepoXraySchema.safeParse(artifact.content);
      if (!xray.success) return none;
      const top = [...xray.data.improvements].sort((a, b) => a.rank - b.rank)[0];
      return {
        metrics: [
          metric("Improvements", xray.data.improvements.length),
          metric("Hotspots", xray.data.hotspots.length),
          ...(top === undefined ? [] : [metric("Top improvement", top.title)]),
        ],
        links: [],
        needsHuman: [],
      };
    }
    case "ship-a-pr": {
      const result = ShipResultSchema.safeParse(artifact.content);
      if (!result.success) return none;
      const tests =
        result.data.after.passed === null ? "not run" : result.data.after.passed ? "pass" : "fail";
      const pr = result.data.pullRequest;
      return {
        metrics: [
          metric("Result", result.data.status.replace("_", " ")),
          metric("Tests after", tests),
          metric(
            "Diff",
            `+${String(result.data.diffStat.additions)} −${String(result.data.diffStat.deletions)}`,
          ),
        ],
        links: pr === undefined ? [] : [{ label: `PR #${String(pr.number)}`, href: pr.url }],
        needsHuman:
          result.data.status === "opened" && pr !== undefined
            ? [`Review and merge pull request #${String(pr.number)} on ${result.data.repo}.`]
            : result.data.status === "patch_ready"
              ? [
                  `Apply the patch for ${result.data.repo} from the Ship-a-PR run, or connect GitHub so Delegate can open the pull request after your approval.`,
                ]
              : ["The change was not shipped: the diff was rejected or timed out."],
      };
    }
  }
}

export function summariseChild(
  missionId: ChildMissionId,
  childRunId: string,
  events: readonly RunEvent[],
): ChildOutcome {
  const terminal = events.findLast(
    (event) => event.type === "run.completed" || event.type === "run.failed",
  );
  const artifact = childArtifacts(events).get(CHILD_DELIVERABLE_KINDS[missionId]);
  const runLink: Link = { label: "Open the run", href: `/runs/${childRunId}` };
  const details = artifact === undefined ? none : detailsFor(missionId, artifact, events);
  const deliverable =
    artifact === undefined
      ? null
      : {
          artifactId: artifact.artifactId,
          kind: artifact.kind,
          title: cut(artifact.title, 200),
        };
  if (terminal?.type === "run.completed")
    return {
      status: "completed",
      summary: cut(terminal.payload.summary, 600),
      deliverable,
      metrics: details.metrics.slice(0, 6),
      links: [runLink, ...details.links].slice(0, 4),
      needsHuman: details.needsHuman.slice(0, 4),
    };
  const error =
    terminal?.type === "run.failed"
      ? { code: terminal.payload.error.code, message: cut(terminal.payload.error.message, 400) }
      : { code: "not_finished", message: "The run has not finished." };
  return {
    status: "failed",
    summary: cut(error.message, 600),
    error,
    deliverable,
    metrics: details.metrics.slice(0, 6),
    links: [runLink],
    needsHuman: [cut(`Look at the failed run: ${error.message}`, 300)],
  };
}
