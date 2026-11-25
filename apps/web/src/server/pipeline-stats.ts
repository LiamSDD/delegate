import redteamReport from "../../../../packages/evals/results/redteam.json";

import { RedteamReportSchema } from "./eval-results";

export interface PipelineStats {
  attacksBlocked: number;
  attacks: number;
  suite: string;
}

export function pipelineStats(raw: unknown = redteamReport): PipelineStats | null {
  const parsed = RedteamReportSchema.safeParse(raw);
  if (!parsed.success || parsed.data.attacks === 0) return null;
  return {
    attacksBlocked: parsed.data.attacks - parsed.data.successes,
    attacks: parsed.data.attacks,
    suite: parsed.data.suite,
  };
}
