import { GOAL_MAX_CHARS } from "@delegate/runtime";

import type { DetectedMission } from "./detect-mission";
import type { StartRunRequest } from "./runs/start-run";

export type CompanyMission = "automation-audit" | "company-xray";

export interface RunChoice {
  companyMission: CompanyMission;
  department?: string;
}

function goalRequest(goal: string): StartRunRequest {
  return { missionId: "custom-goal", input: { goal: goal.slice(0, GOAL_MAX_CHARS) } };
}

export function runRequestFor(detected: DetectedMission, choice: RunChoice): StartRunRequest {
  switch (detected.kind) {
    case "company": {
      const department = choice.department?.trim() ?? "";
      return {
        missionId: choice.companyMission,
        input:
          choice.companyMission === "automation-audit" && department !== ""
            ? { url: detected.url, department }
            : { url: detected.url },
      };
    }
    case "repo":
      return goalRequest(`Assess the open-source project ${detected.target} (${detected.url})`);
    case "goal":
      return goalRequest(detected.target);
  }
}

export function runLabelFor(detected: DetectedMission | null, choice: RunChoice): string {
  if (detected?.kind !== "company") return "Run goal";
  return choice.companyMission === "automation-audit" ? "Run audit" : "Run X-ray";
}
