import { CAPABILITIES } from "@delegate/policy";

import { AutomationAuditInputSchema } from "./automation-audit/input";
import { AutomationAuditSchema } from "./automation-audit/schema";
import { BuildAgentInputSchema } from "./build-agent/input";
import { ASSISTANT_KIND, AssistantArtifactSchema } from "./build-agent/schema";
import { CompanyXrayBriefSchema } from "./company-xray/brief";
import { CompanyXrayInputSchema } from "./company-xray/input";
import { XRAY_PLAN } from "./company-xray/plan";
import { CustomGoalInputSchema } from "./custom-goal/input";
import { GOAL_BRIEF_KIND, GoalBriefSchema } from "./custom-goal/schema";

export const MISSIONS = {
  "company-xray": {
    id: "company-xray",
    title: "Company X-ray",
    description:
      "A cited brief on any company from its public, keyless footprint: offering, customers, market, competitors, positioning, recent news, SWOT and tech-stack signals. Every claim cites a fetched source and is checked by the critic; sections without evidence say so.",
    inputSchema: CompanyXrayInputSchema,
    deliverableSchema: CompanyXrayBriefSchema,
    deliverableKind: "company-xray-brief",
    capabilities: [...new Set(XRAY_PLAN.flatMap((step) => step.capabilities))],
  },
  "automation-audit": {
    id: "automation-audit",
    title: "AI Automation Audit",
    description:
      "5–8 workflows specific to this company that AI agents could automate, ranked by estimated €/month from an explicit ROI model (frequency × minutes × people × adoption). Every opportunity cites evidence about this company; generic ideas are rejected in code.",
    inputSchema: AutomationAuditInputSchema,
    deliverableSchema: AutomationAuditSchema,
    deliverableKind: "automation-audit",
    capabilities: [CAPABILITIES.webFetch, CAPABILITIES.artifactWrite],
  },
  "build-agent": {
    id: "build-agent",
    title: "Build-an-Agent",
    description:
      "Turns an automation opportunity into a working assistant trained on the company's own public website: polite same-domain crawl, hybrid retrieval (full-text, plus embeddings when available) with reranking, cited answers that refuse when the site is silent, an auto-generated eval set with a self-evaluation score, and a gaps report.",
    inputSchema: BuildAgentInputSchema,
    deliverableSchema: AssistantArtifactSchema,
    deliverableKind: ASSISTANT_KIND,
    capabilities: [CAPABILITIES.webFetch, CAPABILITIES.artifactWrite],
  },
  "custom-goal": {
    id: "custom-goal",
    title: "Custom goal",
    description:
      "Any goal in plain language. The planner composes a 3–8 step plan from the existing research, reading, synthesis and critic steps; a company or domain named in the goal is resolved (typed domain, else Wikidata). Deliverable: a cited goal brief with findings by workstream, a ranked action plan mapped to follow-up missions, and risks.",
    inputSchema: CustomGoalInputSchema,
    deliverableSchema: GoalBriefSchema,
    deliverableKind: GOAL_BRIEF_KIND,
    capabilities: [CAPABILITIES.webFetch, CAPABILITIES.artifactWrite],
  },
} as const;

export type MissionId = keyof typeof MISSIONS;
export const MISSION_IDS = Object.keys(MISSIONS) as MissionId[];

export * from "./company-xray";
export * from "./automation-audit";
export * from "./next-actions";
export * from "./build-agent";
export * from "./custom-goal";
