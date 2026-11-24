import { CompanyXrayBriefSchema } from "./company-xray/brief";
import { CompanyXrayInputSchema } from "./company-xray/input";
import { XRAY_PLAN } from "./company-xray/plan";

export const MISSIONS = {
  "company-xray": {
    id: "company-xray",
    title: "Company X-ray",
    description:
      "A cited brief on any company from its public, keyless footprint: offering, customers, market, competitors, positioning, recent news, SWOT and tech-stack signals. Every claim cites a fetched source; sections without evidence say so.",
    inputSchema: CompanyXrayInputSchema,
    deliverableSchema: CompanyXrayBriefSchema,
    capabilities: [...new Set(XRAY_PLAN.flatMap((step) => step.capabilities))],
  },
} as const;

export type MissionId = keyof typeof MISSIONS;
export const MISSION_IDS = Object.keys(MISSIONS) as MissionId[];

export * from "./company-xray";
