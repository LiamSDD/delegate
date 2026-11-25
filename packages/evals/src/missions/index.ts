import { EVAL_MISSIONS, type EvalMission, type MissionAdapter } from "./adapter";
import { auditMission } from "./audit";
import { buildMission } from "./build";
import { goalMission } from "./goal";
import { repoMission } from "./repo";
import { xrayMission } from "./xray";

export const MISSION_ADAPTERS: Record<EvalMission, MissionAdapter> = {
  xray: xrayMission,
  audit: auditMission,
  build: buildMission,
  repo: repoMission,
  goal: goalMission,
};

export function missionAdapter(mission: EvalMission): MissionAdapter {
  return MISSION_ADAPTERS[mission];
}

export { EVAL_MISSIONS, type EvalMission };
