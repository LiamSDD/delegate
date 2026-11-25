import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type RunMissionOptions } from "@delegate/runtime/server";
import { describe, expect, it } from "vitest";

import { runDir } from "../judge/agreement-store";
import { EvalResultFileSchema } from "../results";
import { resultFilePath, runEval, type RunEvalDeps, type RunEvalOptions } from "../runner";
import { loadBuildDataset } from "../datasets/build";
import {
  auditFixtureDrafts,
  buildFixtureDrafts,
  fixtureAnswers,
  goalFixtureDrafts,
  scriptedRunMission,
} from "../testing/mission-fixtures";
import { repoFixtureEvents } from "../testing/repo-fixture";
import { xrayFixtureEvents } from "../testing/xray-fixture";
import { EVAL_MISSIONS, missionAdapter, type EvalMission } from ".";

const ALL_CRITERIA_VERDICT = JSON.stringify(
  Object.fromEntries(
    EVAL_MISSIONS.flatMap((mission) => missionAdapter(mission).judge.criteria).map((criterion) => [
      criterion,
      { score: 4, rationale: "ok" },
    ]),
  ),
);

async function draftsFor(options: RunMissionOptions) {
  const input = options.input as Record<string, unknown>;
  switch (options.missionId) {
    case "automation-audit": {
      const evalCase = missionAdapter("audit")
        .loadCases()
        .find((c) => JSON.stringify(missionAdapter("audit").input(c)) === JSON.stringify(input));
      return auditFixtureDrafts(evalCase as never);
    }
    case "build-agent": {
      const evalCase = loadBuildDataset().find((c) => c.input.url === input.url);
      if (evalCase === undefined) throw new Error("unknown build case");
      return buildFixtureDrafts(evalCase);
    }
    case "custom-goal": {
      const evalCase = missionAdapter("goal")
        .loadCases()
        .find((c) => JSON.stringify(missionAdapter("goal").input(c)) === JSON.stringify(input));
      return goalFixtureDrafts(evalCase as never);
    }
    case "repo-xray":
      return (await repoFixtureEvents(String(input.url))).map(
        ({ seq: _seq, at: _at, runId: _runId, ...draft }) => draft,
      );
    default:
      return (await xrayFixtureEvents()).map(
        ({ seq: _seq, at: _at, runId: _runId, ...draft }) => draft,
      );
  }
}

function deps(judgeCalls: string[] = []): RunEvalDeps {
  let tick = Date.parse("2026-11-25T10:00:00.000Z");
  return {
    runMission: scriptedRunMission(draftsFor),
    env: {},
    now: () => new Date((tick += 250)),
    sleep: () => Promise.resolve(),
    judgeCompleter: {
      complete: (request) => {
        judgeCalls.push(request.system.slice(0, 60));
        return Promise.resolve({ text: ALL_CRITERIA_VERDICT, provider: "fake", model: "judge" });
      },
    },
    checkLinks: (urls) => Promise.resolve(new Map(urls.map((url) => [url, { ok: true }]))),
    answerQuestion: fixtureAnswers(loadBuildDataset()),
    log: () => undefined,
  };
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
      expect(live.judgeServing).toEqual([{ provider: "fake", model: "judge", calls: 2 }]);
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
            (await draftsFor(runOptions))[0] ?? { type: "run.completed", payload: { summary: "" } },
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
        return draftsFor(runOptions);
      }),
    });
    expect(sleeps).toEqual([90_000]);
    expect(summary.overall.retries).toBe(1);
    expect(summary.overall.errored).toBe(0);
  });
});
