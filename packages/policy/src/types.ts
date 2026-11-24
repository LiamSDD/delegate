import { z } from "zod";

export const DATA_CLASSIFICATIONS = ["public", "internal", "confidential", "restricted"] as const;
export const DataClassificationSchema = z.enum(DATA_CLASSIFICATIONS);
export type DataClassification = z.infer<typeof DataClassificationSchema>;

export const PROVIDER_TERMS = ["public-demo-ok", "evaluation-only", "local-only", "byok"] as const;
export const ProviderTermsSchema = z.enum(PROVIDER_TERMS);
export type ProviderTerms = z.infer<typeof ProviderTermsSchema>;

export const DECISIONS = ["allow", "deny", "require_approval"] as const;
export const DecisionKindSchema = z.enum(DECISIONS);
export type DecisionKind = z.infer<typeof DecisionKindSchema>;

const id = z.string().min(1);
const microUsd = z.number().int().nonnegative();

export const PolicyContextSchema = z.object({
  workspaceId: id,
  runId: id,
  stepId: id.optional(),
  actor: z.object({ type: z.enum(["member", "guest", "agent", "system"]), id }),
  tool: id,
  capability: id,
  grantedCapabilities: z.array(id),
  argsSummary: z.string(),
  targetDomain: z.string().optional(),
  dataClassification: DataClassificationSchema.optional(),
  provider: z.object({ id, terms: ProviderTermsSchema }).optional(),
  estimatedCostMicroUsd: microUsd,
  spentRunMicroUsd: microUsd,
  spentDayMicroUsd: microUsd,
});
export type PolicyContext = z.infer<typeof PolicyContextSchema>;

export const DecisionSchema = z.object({
  decision: DecisionKindSchema,
  policyId: id,
  ruleId: id,
  reason: z.string().min(1),
});
export type Decision = z.infer<typeof DecisionSchema>;

const ruleId = id.optional();
const toolList = z.array(id).min(1);

export const RuleSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("require_approval"), id: ruleId, tools: toolList }),
  z.strictObject({ kind: z.literal("deny_tools"), id: ruleId, tools: toolList }),
  z.strictObject({
    kind: z.literal("capability_allowlist"),
    id: ruleId,
    capabilities: z.array(id),
  }),
  z.strictObject({
    kind: z.literal("egress_allowlist"),
    id: ruleId,
    capabilities: z.array(id),
    domains: z.array(id),
  }),
  z.strictObject({
    kind: z.literal("spend_cap"),
    id: ruleId,
    perRunMicroUsd: microUsd.optional(),
    perDayMicroUsd: microUsd.optional(),
    onExceed: z.enum(["deny", "require_approval"]).default("deny"),
  }),
  z.strictObject({
    kind: z.literal("classification"),
    id: ruleId,
    classifications: z.array(DataClassificationSchema).min(1),
    forbiddenTools: z.array(id).default([]),
    forbiddenProviders: z.array(id).default([]),
    forbiddenProviderTerms: z.array(ProviderTermsSchema).default([]),
  }),
  z.strictObject({
    kind: z.literal("provider_terms"),
    id: ruleId,
    allowed: z.array(ProviderTermsSchema),
  }),
]);
export type Rule = z.infer<typeof RuleSchema>;
export type RuleInput = z.input<typeof RuleSchema>;

export const PolicySchema = z.strictObject({
  id,
  name: z.string().min(1),
  description: z.string().optional(),
  rules: z.array(RuleSchema),
});
export type Policy = z.infer<typeof PolicySchema>;
