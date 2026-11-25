import { z } from "zod";

import { PlanStepSchema, type PlanStep } from "./events";

export const PlanApprovalDecisionSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("approved"), steps: z.array(PlanStepSchema).optional() }),
  z.object({ decision: z.literal("rejected"), reason: z.string().optional() }),
]);
export type PlanApprovalDecision = z.infer<typeof PlanApprovalDecisionSchema>;

export type PlanApprovalRequest = { version: number; steps: PlanStep[] } & (
  { kind: "initial" } | { kind: "revision"; required: boolean }
);

export function mayAutoApprovePlan(request: PlanApprovalRequest): boolean {
  return request.kind === "initial" || !request.required;
}

export type AwaitPlanApproval = (
  plan: PlanApprovalRequest,
  signal?: AbortSignal,
) => Promise<PlanApprovalDecision>;
