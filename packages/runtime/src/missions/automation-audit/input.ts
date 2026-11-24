import { z } from "zod";

import { CompanyUrlSchema } from "../company-xray/input";

export const AutomationAuditInputSchema = z.object({
  url: CompanyUrlSchema,
  department: z.string().trim().min(1).max(120).optional(),
  focus: z.string().trim().min(1).max(500).optional(),
});
export type AutomationAuditInput = z.infer<typeof AutomationAuditInputSchema>;
