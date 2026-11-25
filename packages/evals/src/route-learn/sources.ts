import { loadModelsConfig } from "@delegate/runtime/server";

import { MISSION_TARGETS } from "../evolve/targets";
import { EVAL_MISSIONS } from "../results";
import { loadResultFiles } from "../train/arm-store";
import { type RoleChains, type RoutingSource } from "./learn";
import { type RoutingRole } from "./schema";

export function loadRoutingSources(resultsDir: string): RoutingSource[] {
  return EVAL_MISSIONS.flatMap((mission) =>
    loadResultFiles(resultsDir, mission).map((file) => ({
      path: `packages/evals/results/${mission}/${file.id}.json`,
      file,
    })),
  );
}

export function configuredChains(modelsConfig?: unknown): RoleChains {
  const config = loadModelsConfig(modelsConfig);
  const chain = (role: RoutingRole) =>
    config.roles[role].map((entry) => ({ provider: entry.provider, model: entry.model }));
  return { planner: chain("planner"), worker: chain("worker"), fast: chain("fast") };
}

export function runtimeMissionIds(): Record<string, string> {
  return Object.fromEntries(
    EVAL_MISSIONS.map((mission) => [mission, MISSION_TARGETS[mission].runtimeMissionId]),
  );
}
