import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { calibrationPath } from "../judge/agreement-store";
import { appendHumanLabel, loadHumanLabels, parseHumanLabels } from "../judge/calibration";
import { missionAdapter } from "../missions";
import { CalibrationFileSchema } from "../results";
import { runEval } from "../runner";
import { goalFixtureDrafts, scriptedRunMission } from "../testing/mission-fixtures";
import { GOAL_JUDGE_CRITERIA } from "../missions/goal";
import { type CustomGoalCase } from "../datasets/custom-goal";
import { runLabelSession, rubricLines, type LabelIO } from "./session";

const adapter = missionAdapter("goal");
const cases = adapter.loadCases() as CustomGoalCase[];

async function judgedRun(dir: string, scores: number[]) {
  let call = 0;
  let tick = Date.parse("2026-11-25T10:00:00.000Z");
  return runEval(
    {
      mission: "goal",
      trials: scores.length,
      caseIds: [cases[0]?.id ?? ""],
      audience: "public-demo",
      offline: false,
      concurrency: 1,
      baseline: false,
      judge: true,
      resultsDir: dir,
      threshold: 0.05,
    },
    {
      runMission: scriptedRunMission((options) => {
        const evalCase = cases.find(
          (c) => c.input.goal === (options.input as { goal: string }).goal,
        );
        if (evalCase === undefined) throw new Error("unknown goal");
        return goalFixtureDrafts(evalCase);
      }),
      env: {},
      now: () => new Date((tick += 100)),
      sleep: () => Promise.resolve(),
      judgeCompleter: {
        complete: () => {
          const score = scores[call++] ?? 3;
          return Promise.resolve({
            text: JSON.stringify(
              Object.fromEntries(GOAL_JUDGE_CRITERIA.map((c) => [c, { score, rationale: "r" }])),
            ),
            provider: "fake",
            model: "judge",
          });
        },
      },
      log: () => undefined,
    },
  );
}

function scriptedIO(answers: string[]): LabelIO & { printed: string[]; asked: string[] } {
  const printed: string[] = [];
  const asked: string[] = [];
  return {
    printed,
    asked,
    ask: (question) => {
      asked.push(question);
      return Promise.resolve(answers.shift() ?? "q");
    },
    print: (text) => printed.push(text),
  };
}

describe("human label storage", () => {
  it("appends validated labels and refuses a second label of the same trial by the same person", () => {
    const file = join(mkdtempSync(join(tmpdir(), "labels-")), "human-labels.v1.jsonl");
    const label = {
      caseId: "a",
      run: "r1",
      trial: 0,
      labeller: "owner",
      labelledAt: "2026-11-25",
      scores: { relevance: 4, specificity: 3, actionability: 2, citationFaithfulness: 5 },
    };
    appendHumanLabel(file, label, GOAL_JUDGE_CRITERIA);
    expect(() => appendHumanLabel(file, label, GOAL_JUDGE_CRITERIA)).toThrow(/already labelled/);
    appendHumanLabel(file, { ...label, labeller: "reviewer-2" }, GOAL_JUDGE_CRITERIA);
    expect(loadHumanLabels(file, GOAL_JUDGE_CRITERIA)).toHaveLength(2);
    expect(() =>
      appendHumanLabel(file, { ...label, trial: 1, scores: { relevance: 4 } }, GOAL_JUDGE_CRITERIA),
    ).toThrow(/scores must cover exactly/);
    expect(() =>
      appendHumanLabel(
        file,
        { ...label, trial: 2, scores: { ...label.scores, relevance: 6 } },
        GOAL_JUDGE_CRITERIA,
      ),
    ).toThrow();
    expect(() => parseHumanLabels('{"caseId":"a"}')).toThrow(/line 1 is invalid/);
  });

  it("keeps the committed X-ray label file valid for its criteria", () => {
    expect(
      loadHumanLabels(join(__dirname, "../../datasets/company-xray/human-labels.v1.jsonl")),
    ).toEqual([]);
  });
});

describe("runLabelSession", () => {
  it("shows the rubric and deliverable blind, records scores and reports judge-human agreement", async () => {
    const dir = mkdtempSync(join(tmpdir(), "label-session-"));
    const labelsFile = join(dir, "human-labels.v1.jsonl");
    const run = await judgedRun(dir, [4, 2]);
    const io = scriptedIO(["4", "4", "4", "4", "", "7", "2", "2", "2", "2", "thin brief"]);
    const result = await runLabelSession(
      adapter,
      {
        resultsDir: dir,
        labeller: "owner",
        labelsFile,
        now: () => new Date("2026-11-25T12:00:00Z"),
      },
      io,
    );
    expect(result).toMatchObject({ saved: 2, skipped: 0 });
    const output = io.printed.join("\n");
    expect(output).toContain(`run ${run.id}`);
    expect(output).toContain("**relevance**");
    expect(output).toContain(`Goal: ${cases[0]?.input.goal ?? ""}`);
    expect(output).not.toMatch(/"score":/);
    expect(output).toContain("Type a whole number from 1 to 5");
    const labels = parseHumanLabels(readFileSync(labelsFile, "utf8"), GOAL_JUDGE_CRITERIA);
    expect(labels.map((l) => [l.run, l.trial, l.scores.relevance, l.notes])).toEqual([
      [run.id, 0, 4, undefined],
      [run.id, 1, 2, "thin brief"],
    ]);
    expect(result.agreement).toMatchObject({ status: "ok", labels: 2, matched: 2 });
    if (result.agreement.status !== "ok") throw new Error("expected agreement");
    expect(result.agreement.criteria.map((c) => [c.criterion, c.exactMatchRate, c.kappa])).toEqual(
      GOAL_JUDGE_CRITERIA.map((c) => [c, 1, 1]),
    );
    const calibration = CalibrationFileSchema.parse(
      JSON.parse(readFileSync(calibrationPath(dir, "goal"), "utf8")) as unknown,
    );
    expect(calibration.agreement).toMatchObject({ status: "ok", matched: 2 });

    const again = scriptedIO([]);
    expect(
      (
        await runLabelSession(
          adapter,
          { resultsDir: dir, labeller: "owner", labelsFile, now: () => new Date() },
          again,
        )
      ).saved,
    ).toBe(0);
    expect(again.printed[0]).toContain("Nothing to label");
  });

  it("skips with s and stops with q without writing partial labels", async () => {
    const dir = mkdtempSync(join(tmpdir(), "label-quit-"));
    const labelsFile = join(dir, "human-labels.v1.jsonl");
    await judgedRun(dir, [3, 3]);
    const io = scriptedIO(["s", "3", "q"]);
    const result = await runLabelSession(
      adapter,
      { resultsDir: dir, labeller: "owner", labelsFile, now: () => new Date() },
      io,
    );
    expect(result).toMatchObject({
      saved: 0,
      skipped: 1,
      agreement: { status: "no_human_labels" },
    });
    expect(existsSync(labelsFile)).toBe(false);
    expect(existsSync(calibrationPath(dir, "goal"))).toBe(false);
  });

  it("reads rubric definitions from the versioned judge prompt", () => {
    expect(rubricLines("- **a**: first\n- **b**: second", ["a", "b", "c"])).toEqual([
      "- **a**: first",
      "- **b**: second",
      "- c",
    ]);
  });
});
