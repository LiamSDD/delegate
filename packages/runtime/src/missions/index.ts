import { CAPABILITIES } from "@delegate/policy";

import { AutomationAuditInputSchema } from "./automation-audit/input";
import { AutomationAuditSchema } from "./automation-audit/schema";
import { BuildAgentInputSchema } from "./build-agent/input";
import { ASSISTANT_KIND, AssistantArtifactSchema } from "./build-agent/schema";
import { CompanyXrayBriefSchema } from "./company-xray/brief";
import { CompanyXrayInputSchema } from "./company-xray/input";
import { XRAY_PLAN } from "./company-xray/plan";
import { RepoXrayInputSchema } from "./repo-xray/input";
import { REPO_PLAN } from "./repo-xray/plan";
import { REPO_XRAY_KIND, RepoXraySchema } from "./repo-xray/schema";

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
  "repo-xray": {
    id: "repo-xray",
    title: "Repo X-ray",
    description:
      "Architecture map, module responsibilities, onboarding guide, dependency and security hotspots, test-coverage gaps and 5–8 ranked, testable improvements for a public GitHub repository. The repository is fetched once as a tarball, analysed in code first, its documentation read in quarantine, and every claim cites path:line ranges the critic verifies against the stored snapshot.",
    inputSchema: RepoXrayInputSchema,
    deliverableSchema: RepoXraySchema,
    deliverableKind: REPO_XRAY_KIND,
    capabilities: [...new Set(REPO_PLAN.flatMap((step) => step.capabilities))],
  },
} as const;

export type MissionId = keyof typeof MISSIONS;
export const MISSION_IDS = Object.keys(MISSIONS) as MissionId[];

export * from "./company-xray";
export * from "./automation-audit";
export * from "./next-actions";
export * from "./build-agent";
export * from "./repo-xray";
