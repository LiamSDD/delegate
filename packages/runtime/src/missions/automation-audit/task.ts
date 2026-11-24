import { z } from "zod";

import { type QuarantineTask } from "../../quarantine/reader";

export const AUDIT_TOPICS = [
  "company",
  "offering",
  "customers",
  "pricing",
  "hiring",
  "team",
  "support",
  "sales",
  "operations",
  "finance",
  "engineering",
  "integrations",
  "scale",
  "other",
] as const;
export type AuditTopic = (typeof AUDIT_TOPICS)[number];

export const AUDIT_GAP_TOPICS: readonly AuditTopic[] = [
  "customers",
  "hiring",
  "support",
  "pricing",
  "integrations",
];

export const AUDIT_READER_TASK: QuarantineTask<{ topic: string }> = {
  name: "automation-audit",
  instructions:
    "Extract facts that reveal how this company works day to day: what it sells and to whom, named customers and case-study results, pricing tiers and plans, open roles and the teams hiring (job titles, locations, tools named in job ads), support channels and service levels, sales motions (demos, trials, quotes, RFPs), operational processes, volumes and scale (number of customers, orders, users, countries, employees), integrations and tools it uses or offers, documentation and developer resources.",
  extraSchema: z.object({ topic: z.enum(AUDIT_TOPICS).catch("other") }),
  extraDescription: `"topic": one of ${AUDIT_TOPICS.join(", ")}`,
  maxFactsPerSource: 8,
};
