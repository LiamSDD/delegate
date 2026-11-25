import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type RunMissionOptions, type RunMissionResult } from "@delegate/runtime/server";
import { describe, expect, it } from "vitest";

import { fixtureBrief, xrayFixtureEvents, type FixtureOptions } from "./testing/xray-fixture";
import { EvalResultFileSchema, scoreboard } from "./results";
import { runDir } from "./judge/agreement-store";
import { resultFilePath, runEval, type RunEvalDeps, type RunEvalOptions } from "./runner";

const verdict = JSON.stringify({
  accuracy: { score: 4, rationale: "ok" },
  specificity: { score: 4, rationale: "ok" },
  actionability: { score: 3, rationale: "ok" },
  citationFaithfulness: { score: 5, rationale: "ok" },
  facts: [],
});

function scriptedMission(script: (call: number) => FixtureOptions) {
  let calls = 0;
  const runMission = async (options: RunMissionOptions): Promise<RunMissionResult> => {
    const events = await xrayFixtureEvents(script(calls++));
    for (const event of events.slice(1)) {
      const { seq: _seq, at: _at, ...draft } = event;
      await options.emit({ ...draft, runId: options.runId });
    }
    return {
      status: events.some((event) => event.type === "run.completed") ? "completed" : "failed",
    };
  };
  return { runMission, calls: () => calls };
}

function deps(mission: RunEvalDeps["runMission"], sleeps: number[] = []): RunEvalDeps {
  let tick = Date.parse("2026-11-24T10:00:00.000Z");
  return {
    runMission: mission,
    env: {},
    now: () => new Date((tick += 500)),
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    judgeCompleter: {
      complete: () => Promise.resolve({ text: verdict, provider: "fake", model: "judge" }),
    },
    checkLinks: (urls) =>
      Promise.resolve(new Map(urls.map((url) => [url, { ok: true, status: 200 }]))),
    log: () => undefined,
  };
}

function options(resultsDir: string, overrides: Partial<RunEvalOptions> = {}): RunEvalOptions {
  return {
    trials: 2,
    caseIds: ["atlassian", "zed"],
    audience: "public-demo",
    offline: false,
    concurrency: 1,
    baseline: false,
    judge: true,
    resultsDir,
    threshold: 0.05,
    ...overrides,
  };
}

describe("runEval", () => {
  it("runs, records, grades, judges and aggregates every trial", async () => {
    const dir = mkdtempSync(join(tmpdir(), "evals-"));
    const mission = scriptedMission(() => ({}));
    const summary = await runEval(options(dir), deps(mission.runMission));
    expect(mission.calls()).toBe(4);
    expect(summary.mode).toBe("live");
    expect(summary.cases.map((c) => c.caseId)).toEqual(["atlassian", "zed"]);
    const [atlassian] = summary.cases;
    expect(atlassian?.passRate).toMatchObject({ rate: 1, n: 2 });
    expect(atlassian?.score.mean).toBe(1);
    expect(atlassian?.judge.accuracy?.mean).toBe(0.75);
    expect(summary.overall.passRate.n).toBe(4);
    expect(summary.overall.hardFailures).toBe(0);
    expect(summary.serving).toContainEqual({
      role: "planner",
      provider: "pollinations",
      model: "openai",
      calls: 4,
    });
    expect(summary.promptVersions).toMatchObject({ "company-xray-synthesis": 2, "xray-judge": 1 });
    const dirOfRun = runDir(dir, "xray", summary.id);
    expect(existsSync(join(dirOfRun, "atlassian", "0.events.jsonl"))).toBe(true);
    expect(existsSync(join(dirOfRun, "zed", "1.judge.json"))).toBe(true);
    expect(readFileSync(join(dirOfRun, "summary.md"), "utf8")).toContain("No human labels yet");
    expect(existsSync(join(dir, "baseline.json"))).toBe(false);
    const file = EvalResultFileSchema.parse(
      JSON.parse(readFileSync(resultFilePath(dir, summary), "utf8")) as unknown,
    );
    expect(resultFilePath(dir, summary)).toBe(join(dir, "xray", `${summary.id}.json`));
    expect(file).toMatchObject({
      mission: "xray",
      mode: "live",
      trialsPerCase: 2,
      dataset: { name: "company-xray", version: 1 },
      agreement: { status: "no_human_labels" },
    });
    expect(file.cases.map((entry) => entry.trials.length)).toEqual([2, 2]);
    expect(file.promptVersions).toMatchObject({ "xray-judge": 1 });
    const board = scoreboard(file);
    expect(board.passRate).toMatchObject({ rate: 1, n: 4 });
    expect(board.citationAccuracy).toMatchObject({ rate: 1, n: 4 });
    expect(board.judge?.n).toBe(4);
  });

  it("replays stored event logs offline with the same deterministic grades", async () => {
    const dir = mkdtempSync(join(tmpdir(), "evals-"));
    const live = await runEval(options(dir), deps(scriptedMission(() => ({})).runMission));
    const never = (): Promise<RunMissionResult> =>
      Promise.reject(new Error("offline replay must not run missions"));
    const replay = await runEval(
      options(dir, { offline: true, replayDir: runDir(dir, "xray", live.id) }),
      deps(never),
    );
    expect(replay.mode).toBe("replay");
    expect(replay.cases.map((c) => c.score.mean)).toEqual(live.cases.map((c) => c.score.mean));
    expect(replay.cases[0]?.judge.accuracy?.mean).toBe(0.75);
    expect(readFileSync(join(runDir(dir, "xray", replay.id), "summary.md"), "utf8")).toContain(
      "Replay",
    );
  });

  it("writes a baseline only on request and flags a meaningful regression against it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "evals-"));
    await runEval(
      options(dir, { baseline: true, trials: 3 }),
      deps(scriptedMission(() => ({})).runMission),
    );
    expect(existsSync(join(dir, "baseline.json"))).toBe(true);
    const brief = fixtureBrief();
    brief.sources[0]?.quotes.push("fabricated quote that is not in the page");
    const worse = await runEval(
      options(dir, { trials: 3 }),
      deps(scriptedMission(() => ({ brief })).runMission),
    );
    expect(worse.overall.hardFailures).toBe(6);
    expect(worse.regressions.map((r) => r.metric)).toContain("score");
    expect(
      worse.comparisons.find((c) => c.scope === "overall" && c.metric === "score"),
    ).toMatchObject({
      status: "compared",
      regression: true,
    });
  });

  it("backs off and retries when free model capacity is exhausted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "evals-"));
    const sleeps: number[] = [];
    const mission = scriptedMission((call) =>
      call === 0 ? { failure: { code: "no_model_available", message: "capacity" } } : {},
    );
    const summary = await runEval(
      options(dir, { trials: 1, caseIds: ["zed"] }),
      deps(mission.runMission, sleeps),
    );
    expect(mission.calls()).toBe(2);
    expect(sleeps).toEqual([60_000]);
    expect(summary.overall.retries).toBe(1);
    expect(summary.cases[0]?.score.n).toBe(1);
    expect(readdirSync(join(runDir(dir, "xray", summary.id), "zed"))).toContain(
      "0.attempt-0.events.jsonl",
    );
  });
});
