import { z } from "zod";

import { CompanyUrlSchema } from "../company-xray/input";

export const BuildAgentInputSchema = z.object({
  url: CompanyUrlSchema,
  goal: z.string().trim().min(1).max(900),
  name: z.string().trim().min(1).max(80).optional(),
  opportunityId: z.string().trim().min(1).max(40).optional(),
  fromAuditRunId: z.string().trim().min(1).max(100).optional(),
});
export type BuildAgentInput = z.infer<typeof BuildAgentInputSchema>;
