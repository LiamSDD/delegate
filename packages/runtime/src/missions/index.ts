import { CAPABILITIES } from "@delegate/policy";

import { AutomationAuditInputSchema } from "./automation-audit/input";
import { AutomationAuditSchema } from "./automation-audit/schema";
import { CompanyXrayBriefSchema } from "./company-xray/brief";
import { CompanyXrayInputSchema } from "./company-xray/input";
import { XRAY_PLAN } from "./company-xray/plan";

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
} as const;

export type MissionId = keyof typeof MISSIONS;
export const MISSION_IDS = Object.keys(MISSIONS) as MissionId[];

export * from "./company-xray";
export * from "./automation-audit";
export * from "./next-actions";
