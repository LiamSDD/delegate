import { readFileSync } from "node:fs";

import { runDir } from "./judge/agreement-store";
import { EVAL_MISSIONS, missionAdapter, type EvalMission } from "./missions";
import { EvalResultFileSchema } from "./results";
import { resultFilePath, runEval, type EvalSummary, type RunEvalOptions } from "./runner";
import { scriptedEvalDeps } from "./testing/scripted-deps";

export interface SmokeLine {
  mission: EvalMission;
  caseId: string;
  ok: boolean;
  detail: string;
}

function smokeCase(mission: EvalMission): string {
  const cases = missionAdapter(mission).loadCases();
  const chosen = cases.find((c) => c.tags.includes("gate")) ?? cases[0];
  if (chosen === undefined) throw new Error(`${mission} has no cases`);
  return chosen.id;
}

function problems(live: EvalSummary, replay: EvalSummary, resultsDir: string): string[] {
  const found: string[] = [];
  if (replay.mode !== "replay") found.push("second pass was not a replay");
  if (live.overall.hardFailures > 0) found.push(`${live.overall.hardFailures} hard failure(s)`);
  if (
    JSON.stringify(replay.cases.map((c) => c.score)) !==
    JSON.stringify(live.cases.map((c) => c.score))
  )
    found.push("replay scores differ from the recorded run");
  if (JSON.stringify(replay.overall.missionMetrics) !== JSON.stringify(live.overall.missionMetrics))
    found.push("replay mission metrics differ");
  if (replay.overall.judge.overall?.mean !== live.overall.judge.overall?.mean)
    found.push("replayed judge verdicts differ");
  const parsed = EvalResultFileSchema.safeParse(
    JSON.parse(readFileSync(resultFilePath(resultsDir, replay), "utf8")) as unknown,
  );
  if (!parsed.success) found.push("replay result file does not match the schema");
  return found;
}

export async function runSmoke(resultsDir: string): Promise<SmokeLine[]> {
  const lines: SmokeLine[] = [];
  for (const mission of EVAL_MISSIONS) {
    const caseId = smokeCase(mission);
    const options: RunEvalOptions = {
      mission,
      trials: 1,
      caseIds: [caseId],
      audience: "public-demo",
      offline: false,
      concurrency: 1,
      baseline: false,
      judge: true,
      resultsDir,
      threshold: 0.05,
    };
    try {
      const live = await runEval(options, scriptedEvalDeps());
      const replay = await runEval(
        { ...options, offline: true, replayDir: runDir(resultsDir, mission, live.id) },
        scriptedEvalDeps({
          runMission: () => Promise.reject(new Error("replay must not run a mission")),
          answerQuestion: () => Promise.reject(new Error("replay must not ask questions")),
        }),
      );
      const found = problems(live, replay, resultsDir);
      lines.push({
        mission,
        caseId,
        ok: found.length === 0,
        detail:
          found.length === 0
            ? `${replay.overall.trials} trial re-graded, score ${replay.overall.score.mean.toFixed(2)}, ${Object.keys(replay.overall.missionMetrics).length} mission metrics`
            : found.join("; "),
      });
    } catch (error) {
      lines.push({
        mission,
        caseId,
        ok: false,
        detail: error instanceof Error ? error.message.slice(0, 300) : "failed",
      });
    }
  }
  return lines;
}
