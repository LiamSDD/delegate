import { readFileSync } from "node:fs";

import { AutomationAuditInputSchema } from "@delegate/runtime";
import { z } from "zod";

import { CheckSchema } from "../types";
import { datasetFile, parseJsonl, slug } from "./jsonl";
import { CompanySizeSchema } from "./xray";

export const AUDIT_DATASET = { name: "automation-audit", version: 1, file: "v1.jsonl" } as const;

const verified = {
  evidence: z.string().min(5).max(300),
  sourceUrl: z.url({ protocol: /^https$/ }),
  verifiedAt: z.iso.date(),
};
const lowercaseTerm = z
  .string()
  .min(2)
  .max(60)
  .refine((term) => term === term.toLowerCase(), "terms are lowercase");

export const DepartmentHintSchema = z.strictObject({
  id: slug,
  name: z.string().min(2).max(80),
  synonyms: z.array(lowercaseTerm).max(8),
  ...verified,
});
export type DepartmentHint = z.infer<typeof DepartmentHintSchema>;

export const WorkflowHintSchema = z.strictObject({
  id: slug,
  description: z.string().min(5).max(200),
  terms: z.array(lowercaseTerm).min(1).max(6),
  ...verified,
});
export type WorkflowHint = z.infer<typeof WorkflowHintSchema>;

export const AuditCaseSchema = z.strictObject({
  id: slug,
  mission: z.literal("audit"),
  version: z.number().int().positive(),
  input: z.strictObject({
    url: z.url({ protocol: /^https$/ }),
    department: z.string().min(1).max(120).optional(),
    focus: z.string().min(1).max(500).optional(),
  }),
  company: z.strictObject({
    name: z.string().min(1).max(120),
    country: z.string().regex(/^[A-Z]{2}$/),
    industry: slug,
    size: CompanySizeSchema,
  }),
  hints: z.strictObject({
    departments: z.array(DepartmentHintSchema).min(2).max(4),
    workflows: z.array(WorkflowHintSchema).min(2).max(4),
  }),
  difficulty: z.string().min(1).max(600),
  checks: z.array(CheckSchema),
  rubric: z.array(z.string().min(1)),
  tags: z.array(slug),
  notes: z.string().optional(),
});
export type AuditCase = z.infer<typeof AuditCaseSchema>;

export function parseAuditDataset(source: string): AuditCase[] {
  return parseJsonl(source, AuditCaseSchema, "automation-audit dataset", (evalCase) => {
    if (!AutomationAuditInputSchema.safeParse(evalCase.input).success)
      return "input is not a valid automation-audit input";
    const ids = [...evalCase.hints.departments, ...evalCase.hints.workflows].map((h) => h.id);
    return new Set(ids).size === ids.length ? undefined : "duplicate hint id";
  });
}

export function loadAuditDataset(
  path: string = datasetFile(AUDIT_DATASET, AUDIT_DATASET.file),
): AuditCase[] {
  return parseAuditDataset(readFileSync(path, "utf8"));
}
