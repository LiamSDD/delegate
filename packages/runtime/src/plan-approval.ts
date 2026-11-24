import { z } from "zod";

import { PlanStepSchema, type PlanStep } from "./events";

export const PlanApprovalDecisionSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("approved"), steps: z.array(PlanStepSchema).optional() }),
  z.object({ decision: z.literal("rejected"), reason: z.string().optional() }),
]);
export type PlanApprovalDecision = z.infer<typeof PlanApprovalDecisionSchema>;

export type AwaitPlanApproval = (
  plan: { version: number; steps: PlanStep[] },
  signal?: AbortSignal,
) => Promise<PlanApprovalDecision>;
