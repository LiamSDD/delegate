import { z } from "zod";

import { type ChildHandoff, type ChildMissionId, type RunEvent } from "../../events";
import { AutomationAuditInputSchema } from "../automation-audit/input";
import {
  AUTOMATION_AUDIT_KIND,
  AutomationAuditSchema,
  type Opportunity,
} from "../automation-audit/schema";
import { BuildAgentInputSchema } from "../build-agent/input";
import { CompanyXrayInputSchema } from "../company-xray/input";
import { CustomGoalInputSchema } from "../custom-goal/input";
import { GOAL_BRIEF_KIND, GoalBriefSchema, type GoalBrief } from "../custom-goal/schema";
import { NEXT_ACTIONS_KIND, NextActionsSchema } from "../next-actions";
import { RepoXrayInputSchema } from "../repo-xray/input";
import { REPO_XRAY_KIND, RepoXraySchema, type RankedImprovement } from "../repo-xray/schema";
import { ShipAPrInputSchema } from "../ship-a-pr/input";
import { RepoImprovementSchema } from "../repo-xray/schema";
import { type AutopilotInput, type AutopilotTrack } from "./schema";

export const COMPANY_XRAY_BRIEF_KIND = "company-xray-brief";

export interface ChildArtifact {
  artifactId: string;
  kind: string;
  title: string;
  content: unknown;
}

export type ChildArtifacts = ReadonlyMap<string, ChildArtifact>;

export function childArtifacts(events: readonly RunEvent[]): Map<string, ChildArtifact> {
  const byId = new Map<string, ChildArtifact>();
  const byKind = new Map<string, ChildArtifact>();
  for (const event of events) {
    if (event.type === "artifact.created") {
      const artifact = {
        artifactId: event.payload.artifactId,
        kind: event.payload.kind,
        title: event.payload.title,
        content: event.payload.content,
      };
      byId.set(artifact.artifactId, artifact);
      byKind.set(artifact.kind, artifact);
    } else if (event.type === "artifact.updated") {
      const existing = byId.get(event.payload.artifactId);
      if (existing === undefined) continue;
      const updated = {
        ...existing,
        ...(event.payload.title === undefined ? {} : { title: event.payload.title }),
        ...(event.payload.content === undefined ? {} : { content: event.payload.content }),
      };
      byId.set(updated.artifactId, updated);
      byKind.set(updated.kind, updated);
    }
  }
  return byKind;
}

export interface AutopilotNode {
  nodeId: string;
  missionId: ChildMissionId;
  label: string;
}

export const BRIEF_NODE: AutopilotNode = {
  nodeId: "brief",
  missionId: "custom-goal",
  label: "Goal brief",
};

export const TRACK_NODES: Record<
  Exclude<AutopilotTrack, "brief-only">,
  readonly AutopilotNode[]
> = {
  company: [
    { nodeId: "company-xray", missionId: "company-xray", label: "Company X-ray" },
    { nodeId: "audit", missionId: "automation-audit", label: "AI Automation Audit" },
    { nodeId: "build", missionId: "build-agent", label: "Build it" },
  ],
  repo: [
    { nodeId: "repo-xray", missionId: "repo-xray", label: "Repo X-ray" },
    { nodeId: "ship", missionId: "ship-a-pr", label: "Ship a PR" },
  ],
};

export const CONTRACTS = {
  briefTrack: "goal-brief → track",
  xrayAudit: "company-xray → automation-audit",
  auditBuild: "audit opportunity → build-agent",
  improvementShip: "repo improvement → ship-a-pr",
} as const;

export interface Handoff {
  input: Record<string, unknown>;
  from?: ChildHandoff;
}

export type HandoffResult = { ok: true; handoff: Handoff } | { ok: false; message: string };

export type TrackChoice =
  | { ok: true; track: "company" | "repo"; handoff: Handoff; action: string | null }
  | { ok: true; track: "brief-only"; reason: string }
  | { ok: false; message: string };

function issues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

function refused(contract: string, message: string): { ok: false; message: string } {
  return { ok: false, message: `${contract}: ${message}`.slice(0, 400) };
}

export function briefInput(input: AutopilotInput): Record<string, unknown> {
  return CustomGoalInputSchema.parse(input);
}

function goalBrief(artifacts: ChildArtifacts): { artifactId: string; brief: GoalBrief } | string {
  const artifact = artifacts.get(GOAL_BRIEF_KIND);
  if (artifact === undefined) return "the goal brief run published no brief";
  const parsed = GoalBriefSchema.safeParse(artifact.content);
  if (!parsed.success) return `the goal brief is not complete (${issues(parsed.error)})`;
  return { artifactId: artifact.artifactId, brief: parsed.data };
}

const TRACK_OF: Partial<Record<string, "company" | "repo">> = {
  "company-xray": "company",
  "automation-audit": "company",
  "build-agent": "company",
  "repo-xray": "repo",
  "ship-a-pr": "repo",
};

export function chooseTrack(briefRunId: string, artifacts: ChildArtifacts): TrackChoice {
  const found = goalBrief(artifacts);
  if (typeof found === "string") return refused(CONTRACTS.briefTrack, found);
  const listed = NextActionsSchema.safeParse(artifacts.get(NEXT_ACTIONS_KIND)?.content);
  const actions = listed.success ? listed.data.actions : [];
  const nextActionsId = artifacts.get(NEXT_ACTIONS_KIND)?.artifactId;
  for (const action of actions) {
    const track = TRACK_OF[action.missionId];
    if (!action.available || track === undefined) continue;
    const url = typeof action.input.url === "string" ? action.input.url : undefined;
    if (url === undefined) continue;
    const parsed =
      track === "repo"
        ? RepoXrayInputSchema.safeParse({ url })
        : CompanyXrayInputSchema.safeParse({ url });
    if (!parsed.success) continue;
    const input = { url: parsed.data.url };
    const ranked = found.brief.actions.find(
      (entry) => entry.mission !== null && TRACK_OF[entry.mission] === track,
    );
    return {
      ok: true,
      track,
      action: ranked?.title ?? action.label,
      handoff: {
        input,
        from: {
          contract: CONTRACTS.briefTrack,
          fromRunId: briefRunId,
          artifactId: nextActionsId ?? found.artifactId,
          itemId: action.id.slice(0, 80),
          itemTitle: (ranked?.title ?? action.label).slice(0, 160),
        },
      },
    };
  }
  const company = found.brief.company;
  if (company !== null) {
    const parsed = CompanyXrayInputSchema.safeParse({ url: company.url });
    if (parsed.success)
      return {
        ok: true,
        track: "company",
        action: null,
        handoff: {
          input: { url: parsed.data.url },
          from: {
            contract: CONTRACTS.briefTrack,
            fromRunId: briefRunId,
            artifactId: found.artifactId,
            itemTitle: company.name.slice(0, 160),
          },
        },
      };
  }
  return {
    ok: true,
    track: "brief-only",
    reason:
      "The brief names no company website or GitHub repository to act on, so there is nothing to launch; add a URL to the goal to let Autopilot carry it further.",
  };
}

export function auditInputFromXray(
  xrayRunId: string,
  xrayInput: Record<string, unknown>,
  artifacts: ChildArtifacts,
  objective: string | null,
): HandoffResult {
  const artifact = artifacts.get(COMPANY_XRAY_BRIEF_KIND);
  if (artifact === undefined) return refused(CONTRACTS.xrayAudit, "the X-ray published no brief");
  const brief = z
    .object({ company: z.object({ name: z.string().min(1), url: z.url() }) })
    .safeParse(artifact.content);
  const url = brief.success
    ? brief.data.company.url
    : typeof xrayInput.url === "string"
      ? xrayInput.url
      : undefined;
  const parsed = AutomationAuditInputSchema.safeParse({
    url,
    ...(objective === null ? {} : { focus: objective.slice(0, 500) }),
  });
  if (!parsed.success) return refused(CONTRACTS.xrayAudit, issues(parsed.error));
  return {
    ok: true,
    handoff: {
      input: parsed.data,
      from: {
        contract: CONTRACTS.xrayAudit,
        fromRunId: xrayRunId,
        artifactId: artifact.artifactId,
        ...(brief.success ? { itemTitle: brief.data.company.name.slice(0, 160) } : {}),
      },
    },
  };
}

export function pickOpportunity(opportunities: readonly Opportunity[]): Opportunity | undefined {
  return (
    opportunities.find((opportunity) => opportunity.verification !== "unverified") ??
    opportunities[0]
  );
}

export function buildInputFromAudit(
  auditRunId: string,
  auditInput: Record<string, unknown>,
  artifacts: ChildArtifacts,
): HandoffResult {
  const artifact = artifacts.get(AUTOMATION_AUDIT_KIND);
  if (artifact === undefined)
    return refused(CONTRACTS.auditBuild, "the audit published no opportunities");
  const audit = AutomationAuditSchema.safeParse(artifact.content);
  if (!audit.success) return refused(CONTRACTS.auditBuild, issues(audit.error));
  const opportunity = pickOpportunity(audit.data.opportunities);
  if (opportunity === undefined)
    return refused(CONTRACTS.auditBuild, "the audit has no opportunity to build");
  const parsed = BuildAgentInputSchema.safeParse({
    url: auditInput.url,
    goal: opportunity.automation,
    name: opportunity.title.slice(0, 80),
    opportunityId: opportunity.id,
    fromAuditRunId: auditRunId,
  });
  if (!parsed.success) return refused(CONTRACTS.auditBuild, issues(parsed.error));
  return {
    ok: true,
    handoff: {
      input: parsed.data,
      from: {
        contract: CONTRACTS.auditBuild,
        fromRunId: auditRunId,
        artifactId: artifact.artifactId,
        itemId: opportunity.id,
        itemTitle: opportunity.title.slice(0, 160),
      },
    },
  };
}

export function pickImprovement(
  improvements: readonly RankedImprovement[],
): RankedImprovement | undefined {
  const ranked = [...improvements].sort((a, b) => a.rank - b.rank);
  return (
    ranked.find((item) => item.support === undefined && item.effort === "S") ??
    ranked.find((item) => item.support === undefined) ??
    ranked[0]
  );
}

export function shipInputFromXray(xrayRunId: string, artifacts: ChildArtifacts): HandoffResult {
  const artifact = artifacts.get(REPO_XRAY_KIND);
  if (artifact === undefined)
    return refused(CONTRACTS.improvementShip, "the Repo X-ray published no report");
  const xray = RepoXraySchema.safeParse(artifact.content);
  if (!xray.success) return refused(CONTRACTS.improvementShip, issues(xray.error));
  const improvement = pickImprovement(xray.data.improvements);
  if (improvement === undefined)
    return refused(CONTRACTS.improvementShip, "the Repo X-ray ranked no improvement");
  const parsed = ShipAPrInputSchema.safeParse({
    repoUrl: xray.data.repo.url,
    ref: xray.data.repo.ref,
    improvement: RepoImprovementSchema.parse(improvement),
  });
  if (!parsed.success) return refused(CONTRACTS.improvementShip, issues(parsed.error));
  return {
    ok: true,
    handoff: {
      input: parsed.data,
      from: {
        contract: CONTRACTS.improvementShip,
        fromRunId: xrayRunId,
        artifactId: artifact.artifactId,
        itemId: improvement.id,
        itemTitle: improvement.title,
      },
    },
  };
}
