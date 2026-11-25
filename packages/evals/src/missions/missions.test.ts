import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runDir } from "../judge/agreement-store";
import { EVAL_MISSION_INFO, EvalResultFileSchema } from "../results";
import { resultFilePath, runEval, type RunEvalDeps, type RunEvalOptions } from "../runner";
import { loadBuildDataset } from "../datasets/build";
import { fixtureAnswers, scriptedRunMission } from "../testing/mission-fixtures";
import { fixtureDraftsFor, scriptedEvalDeps } from "../testing/scripted-deps";
import { EVAL_MISSIONS, missionAdapter, type EvalMission } from ".";

function deps(): RunEvalDeps {
  return scriptedEvalDeps();
}

function firstCase(mission: EvalMission): string {
  const [first] = missionAdapter(mission).loadCases();
  if (first === undefined) throw new Error(`no ${mission} cases`);
  return first.id;
}

function options(
  dir: string,
  mission: EvalMission,
  overrides: Partial<RunEvalOptions> = {},
): RunEvalOptions {
  return {
    mission,
    trials: 2,
    caseIds: [firstCase(mission)],
    audience: "public-demo",
    offline: false,
    concurrency: 2,
    baseline: false,
    judge: true,
    resultsDir: dir,
    threshold: 0.05,
    ...overrides,
  };
}

describe("mission registry", () => {
  it("matches the web-safe mission list the /evals page renders", () => {
    for (const mission of EVAL_MISSIONS)
      expect(EVAL_MISSION_INFO[mission]).toEqual({
        title: missionAdapter(mission).title,
        dataset: missionAdapter(mission).dataset.name,
      });
  });
});

describe("runEval across missions", () => {
  it.each(EVAL_MISSIONS)(
    "%s: runs, grades, judges, writes a result file and replays identically",
    async (mission) => {
      const dir = mkdtempSync(join(tmpdir(), `evals-${mission}-`));
      const adapter = missionAdapter(mission);
      const live = await runEval(options(dir, mission), deps());
      expect(live.mission).toBe(mission);
      expect(live.dataset).toEqual({
        name: adapter.dataset.name,
        version: adapter.dataset.version,
      });
      expect(live.overall.trials).toBe(2);
      expect(live.overall.hardFailures).toBe(0);
      expect(live.judgeServing).toEqual([{ provider: "fixture", model: "judge", calls: 2 }]);
      expect(Object.keys(live.overall.judge).sort()).toEqual(
        [...adapter.judge.criteria, "overall"].sort(),
      );
      expect(live.promptVersions[adapter.judge.promptFile.replace(/\.v\d+\.md$/, "")]).toBe(1);
      const file = EvalResultFileSchema.parse(
        JSON.parse(readFileSync(resultFilePath(dir, live), "utf8")) as unknown,
      );
      expect(resultFilePath(dir, live)).toBe(join(dir, mission, `${live.id}.json`));
      expect(file.mission).toBe(mission);
      expect(file.cases[0]?.trials).toHaveLength(2);
      expect(Object.keys(file.judgeCriteria ?? {})).toContain("overall");
      expect(Object.keys(file.missionMetrics ?? {}).length).toBeGreaterThan(0);

      const replay = await runEval(
        options(dir, mission, { offline: true, replayDir: runDir(dir, mission, live.id) }),
        { ...deps(), runMission: () => Promise.reject(new Error("replay must not run missions")) },
      );
      expect(replay.mode).toBe("replay");
      expect(replay.cases.map((c) => c.score.mean)).toEqual(live.cases.map((c) => c.score.mean));
      expect(replay.overall.missionMetrics).toEqual(live.overall.missionMetrics);
      expect(replay.overall.judge.overall?.mean).toBe(live.overall.judge.overall?.mean);
    },
  );

  it("build: stores the question-and-answer record next to the event log", async () => {
    const dir = mkdtempSync(join(tmpdir(), "evals-build-qa-"));
    const summary = await runEval(options(dir, "build", { trials: 1, concurrency: 1 }), deps());
    const qaPath = join(runDir(dir, "build", summary.id), firstCase("build"), "0.qa.json");
    expect(existsSync(qaPath)).toBe(true);
    const qa = JSON.parse(readFileSync(qaPath, "utf8")) as { answers: unknown[] };
    const [buildCase] = loadBuildDataset();
    expect(qa.answers).toHaveLength((buildCase?.questions.length ?? 0) + 3);
    expect(summary.overall.missionMetrics.answerAccuracy?.mean).toBe(1);
    expect(summary.overall.missionMetrics.outOfScopeRefusalRate?.mean).toBe(1);
  });

  it("build: an answered out-of-scope question is a hard failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "evals-build-leak-"));
    const [buildCase] = loadBuildDataset();
    const leaked = buildCase?.outOfScope[0]?.question ?? "";
    const summary = await runEval(options(dir, "build", { trials: 1 }), {
      ...deps(),
      answerQuestion: fixtureAnswers(loadBuildDataset(), {
        [leaked]: {
          refused: false,
          refusal: null,
          answer: "France won.",
          citations: [{ url: buildCase?.input.url ?? "" }],
        },
      }),
    });
    expect(summary.overall.hardFailures).toBe(1);
    expect(summary.overall.checkPassRates.out_of_scope_refused).toEqual({ passed: 0, counted: 1 });
  });

  it("waits out a shared cooldown when free capacity is exhausted under concurrency", async () => {
    const dir = mkdtempSync(join(tmpdir(), "evals-cooldown-"));
    const sleeps: number[] = [];
    let calls = 0;
    const summary = await runEval(options(dir, "goal", { trials: 2, concurrency: 2 }), {
      ...deps(),
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      runMission: scriptedRunMission(async (runOptions) => {
        calls += 1;
        if (calls === 1)
          return [
            (await fixtureDraftsFor(runOptions))[0] ?? {
              type: "run.completed",
              payload: { summary: "" },
            },
            {
              type: "model.fallback",
              payload: {
                role: "planner",
                from: { provider: "a", model: "b" },
                to: null,
                reason: "rate_limited",
                retryAfterMs: 90_000,
              },
            },
            {
              type: "run.failed",
              payload: { error: { code: "no_model_available", message: "busy" } },
            },
          ];
        return fixtureDraftsFor(runOptions);
      }),
    });
    expect(sleeps).toEqual([90_000]);
    expect(summary.overall.retries).toBe(1);
    expect(summary.overall.errored).toBe(0);
  });
});
