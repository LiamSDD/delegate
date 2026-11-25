export {
  AUDIT_FORMULA,
  AUTOMATION_AUDIT_KIND,
  type AutomationAudit,
  type AutomationAuditInput,
  AutomationAuditInputSchema,
  AutomationAuditSchema,
  DIFFICULTIES,
  estimateRoi,
  NEXT_ACTIONS_KIND,
  type NextAction,
  NextActionSchema,
  NextActionsSchema,
  type Opportunity,
  OpportunitySchema,
  type PlanStep,
  PlanStepsSchema,
  type RoiEstimate,
  type RoiInputs,
} from "@delegate/runtime";

import type { RoiInputs } from "@delegate/runtime";

export const RUNNABLE_MISSION_IDS = [
  "company-xray",
  "automation-audit",
  "build-agent",
  "repo-xray",
] as const;
export type RunnableMissionId = (typeof RUNNABLE_MISSION_IDS)[number];

export const ROI_INPUT_KEYS = [
  "frequencyPerMonth",
  "minutesPerTask",
  "peopleInvolved",
  "adoptionRate",
  "hourlyCostEur",
] as const;
export type RoiInputKey = (typeof ROI_INPUT_KEYS)[number] & keyof RoiInputs;
export type RoiOverrides = Partial<RoiInputs>;

export const MISSION_LABELS: Record<string, string> = {
  "company-xray": "Company X-ray",
  "automation-audit": "Automation Audit",
  "build-agent": "Build-an-Agent",
  "repo-xray": "Repo X-ray",
};

export function missionLabel(id: string): string {
  return MISSION_LABELS[id] ?? id;
}
