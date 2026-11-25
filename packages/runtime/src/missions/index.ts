import { CAPABILITIES } from "@delegate/policy";

import { AutomationAuditInputSchema } from "./automation-audit/input";
import { AutomationAuditSchema } from "./automation-audit/schema";
import { BuildAgentInputSchema } from "./build-agent/input";
import { ASSISTANT_KIND, AssistantArtifactSchema } from "./build-agent/schema";
import { CompanyXrayBriefSchema } from "./company-xray/brief";
import { CompanyXrayInputSchema } from "./company-xray/input";
import { XRAY_PLAN } from "./company-xray/plan";
import { ShipAPrInputSchema } from "./ship-a-pr/input";
import { SHIP_CAPABILITIES } from "./ship-a-pr/plan";
import { SHIP_RESULT_KIND, ShipResultSchema } from "./ship-a-pr/schema";

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
  "ship-a-pr": {
    id: "ship-a-pr",
    title: "Ship-a-PR",
    description:
      "Implements one Repo X-ray improvement in an isolated sandbox with the Engineer (read, write and run only inside the repository), runs the repository's own tests and lint before and after, and after human approval opens a pull request through the GitHub App on an authorised repository, or hands over a patch and test report.",
    inputSchema: ShipAPrInputSchema,
    deliverableSchema: ShipResultSchema,
    deliverableKind: SHIP_RESULT_KIND,
    capabilities: [...SHIP_CAPABILITIES],
  },
} as const;

export type MissionId = keyof typeof MISSIONS;
export const MISSION_IDS = Object.keys(MISSIONS) as MissionId[];

export * from "./company-xray";
export * from "./automation-audit";
export * from "./next-actions";
export * from "./build-agent";
export * from "./ship-a-pr";
