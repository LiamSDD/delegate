import { z } from "zod";

import { SourceIdSchema, SourceRecordSchema } from "../../tools/sources";
import { AUDIT_FORMULA, estimateRoi } from "./roi";

export const AUTOMATION_AUDIT_KIND = "automation-audit";
export const AUTOMATION_CANDIDATES_KIND = "automation-candidates";
export const MIN_OPPORTUNITIES = 5;
export const MAX_OPPORTUNITIES = 8;

export const DIFFICULTIES = ["low", "medium", "high"] as const;

export const SUPPORT_LEVELS = ["weak", "unverified"] as const;
export const VERIFICATION_STATUSES = ["verified", "partially_verified", "unverified"] as const;
export const VerificationStatusSchema = z.enum(VERIFICATION_STATUSES);
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>;

export const AuditEvidenceSchema = z.object({
  text: z.string().trim().min(1).max(600),
  citations: z.array(SourceIdSchema).min(1).max(8),
  support: z.enum(SUPPORT_LEVELS).optional(),
});
export type AuditEvidence = z.infer<typeof AuditEvidenceSchema>;

export const OpportunitySchema = z.object({
  id: z.string().min(1).max(40),
  title: z.string().trim().min(1).max(140),
  department: z.string().trim().min(1).max(80),
  workflow: z.string().trim().min(1).max(900),
  automation: z.string().trim().min(1).max(900),
  frequencyPerMonth: z.number().nonnegative().max(100_000),
  minutesPerTask: z.number().nonnegative().max(10_000),
  peopleInvolved: z.number().nonnegative().max(100_000),
  adoptionRate: z.number().min(0).max(1),
  hourlyCostEur: z.number().nonnegative().max(1_000),
  difficulty: z.enum(DIFFICULTIES),
  risks: z.array(z.string().trim().min(1).max(300)).max(6),
  integrations: z.array(z.string().trim().min(1).max(80)).max(10),
  firstStep: z.string().trim().min(1).max(500),
  evidence: z.array(AuditEvidenceSchema).min(1).max(6),
  assumptions: z.array(z.string().trim().min(1).max(300)).max(10),
  verification: VerificationStatusSchema.optional(),
});
export type Opportunity = z.infer<typeof OpportunitySchema>;

export const AutomationAuditSchema = z
  .object({
    company: z.string().trim().min(1).max(120),
    summary: z.string().trim().min(1).max(1200),
    opportunities: z.array(OpportunitySchema).min(1).max(MAX_OPPORTUNITIES),
    sources: z.array(SourceRecordSchema),
    formula: z.literal(AUDIT_FORMULA),
    verification: z
      .object({
        status: VerificationStatusSchema,
        citationAccuracy: z.number().min(0).max(1).nullable(),
        note: z.string().max(500).optional(),
      })
      .optional(),
  })
  .superRefine((audit, ctx) => {
    const known = new Set(audit.sources.map((source) => source.sourceId));
    const ids = new Set<string>();
    let previous = Number.POSITIVE_INFINITY;
    for (const opportunity of audit.opportunities) {
      if (ids.has(opportunity.id))
        ctx.addIssue({ code: "custom", message: `Duplicate opportunity id ${opportunity.id}` });
      ids.add(opportunity.id);
      for (const evidence of opportunity.evidence)
        for (const citation of evidence.citations)
          if (!known.has(citation))
            ctx.addIssue({
              code: "custom",
              message: `Citation ${citation} does not match any source`,
            });
      const eur = estimateRoi(opportunity).eurPerMonth;
      if (eur > previous)
        ctx.addIssue({
          code: "custom",
          message: "Opportunities must be ranked by estimated €/month",
        });
      previous = eur;
    }
  });
export type AutomationAudit = z.infer<typeof AutomationAuditSchema>;
