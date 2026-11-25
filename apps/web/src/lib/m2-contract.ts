export {
  AUDIT_FORMULA,
  AUTOMATION_AUDIT_KIND,
  type AutomationAudit,
  type AutomationAuditInput,
  AutomationAuditInputSchema,
  AutomationAuditSchema,
  DIFFICULTIES,
  estimateRoi,
  GOAL_BRIEF_KIND,
  type GoalAction,
  type GoalBrief,
  type GoalBriefDraft,
  GoalBriefDraftSchema,
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
  "custom-goal",
  "repo-xray",
] as const;
export type RunnableMissionId = (typeof RUNNABLE_MISSION_IDS)[number];

export const SHIP_MISSION_ID = "ship-a-pr" as const;
export const AUTOPILOT_MISSION = "autopilot" as const;
export type AutopilotMissionId = typeof AUTOPILOT_MISSION;
export type ExecutableMissionId = RunnableMissionId | typeof SHIP_MISSION_ID;

export function isExecutableMission(mission: string): mission is ExecutableMissionId {
  return (
    mission === SHIP_MISSION_ID || (RUNNABLE_MISSION_IDS as readonly string[]).includes(mission)
  );
}

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
  "ship-a-pr": "Ship-a-PR",
  "custom-goal": "Custom goal",
  "repo-xray": "Repo X-ray",
  autopilot: "Autopilot",
};

export function missionLabel(id: string): string {
  return MISSION_LABELS[id] ?? id;
}
