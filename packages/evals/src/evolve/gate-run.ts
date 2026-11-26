import { type EvalMission } from "../results";
import { runEval, type RunEvalDeps, type RunEvalOptions } from "../runner";
import { missionGateVerdict, missionTargets, type MissionGateVerdict } from "./targets";

export interface GateRunOptions {
  missions: readonly EvalMission[];
  full: boolean;
  threshold?: number;
  base: RunEvalOptions;
}

export interface GateRunResult {
  ok: boolean;
  verdicts: (MissionGateVerdict & { mode: "live" | "replay" })[];
}

export async function runMissionGates(
  options: GateRunOptions,
  deps: RunEvalDeps,
): Promise<GateRunResult> {
  const verdicts: GateRunResult["verdicts"] = [];
  for (const mission of options.missions) {
    const { tag: baseTag, ...base } = options.base;
    const tag = options.full ? baseTag : (baseTag ?? "gate");
    const summary = await runEval(
      {
        ...base,
        mission,
        ...(tag === undefined ? {} : { tag }),
        threshold: options.threshold ?? missionTargets(mission).regression.threshold,
      },
      deps,
    );
    verdicts.push({ ...missionGateVerdict(summary), mode: summary.mode });
  }
  return { ok: verdicts.every((verdict) => verdict.ok), verdicts };
}
