import { parseRunEvent, type RunEvent } from "@delegate/runtime";
import { describe, expect, it } from "vitest";

import { loadBuildDataset } from "../datasets/build";
import { collectAnswers, renderBuildJudgeInput } from "../missions/build";
import {
  FIXTURE_AT,
  buildFixtureDrafts,
  fixtureAnswers,
  fixtureAssistant,
} from "../testing/mission-fixtures";
import { answerMatches, gradeBuild, type QaRecord } from "./build";

const cases = loadBuildDataset();
const evalCase = (() => {
  const [first] = cases;
  if (first === undefined) throw new Error("build dataset is empty");
  return first;
})();
const targets = { maxLatencyMs: 300_000, maxCostMicroUsd: 0, maxTokens: 300_000 };

function log(content: unknown = fixtureAssistant(evalCase)): RunEvent[] {
  return buildFixtureDrafts(evalCase, content).map((draft, index) =>
    parseRunEvent({ ...draft, runId: "run_build", seq: index + 1, at: FIXTURE_AT }),
  );
}

async function qa(overrides: Parameters<typeof fixtureAnswers>[1] = {}): Promise<QaRecord> {
  let tick = 0;
  return collectAnswers(
    {
      evalCase,
      events: log(),
      env: {},
      audience: "public-demo",
      sleep: () => Promise.resolve(),
      now: () => new Date((tick += 10)),
      answer: fixtureAnswers(cases, overrides),
      log: () => undefined,
    },
    {},
  );
}

describe("answerMatches", () => {
  it("needs every expected term after normalising case, quotes and spacing", () => {
    expect(answerMatches("It’s in   SAN francisco.", ["san francisco", "it's"])).toBe(true);
    expect(answerMatches("It is in Oakland.", ["San Francisco"])).toBe(false);
  });
});

describe("gradeBuild", () => {
  it("passes correct, cited answers and refused out-of-scope questions", async () => {
    const grade = gradeBuild({ evalCase, events: log(), targets, extras: await qa() });
    expect(grade.hardFailures).toEqual([]);
    expect(grade.checks.filter((c) => !c.passed).map((c) => c.kind)).toEqual(["self_eval_present"]);
    expect(grade.missionMetrics).toMatchObject({
      answerAccuracy: 1,
      falseRefusalRate: 0,
      outOfScopeRefusalRate: 1,
      citedAnswerRate: 1,
    });
    expect(grade.citationsVerified).toBe(true);
  });

  it("fails leaked out-of-scope answers, off-site citations and uncited answers", async () => {
    const [oos] = evalCase.outOfScope;
    const [first, second] = evalCase.questions;
    const record = await qa({
      [oos?.question ?? ""]: {
        refused: false,
        refusal: null,
        answer: "Sure.",
        citations: [{ url: evalCase.input.url }],
      },
      [first?.question ?? ""]: { citations: [{ url: "https://attacker.example/page" }] },
      [second?.question ?? ""]: { citations: [] },
    });
    const grade = gradeBuild({ evalCase, events: log(), targets, extras: record });
    expect(grade.hardFailures).toEqual([
      "out_of_scope_refused",
      "answers_cited",
      "citations_on_site",
    ]);
    expect(grade.citationsVerified).toBe(false);
  });

  it("counts capacity refusals as unavailable rather than wrong, after retrying", async () => {
    const [first] = evalCase.questions;
    const record = await qa({
      [first?.question ?? ""]: { refused: true, refusal: "unavailable", answer: "", citations: [] },
    });
    expect(record.answers.find((a) => a.questionId === first?.id)?.attempts).toBe(3);
    const grade = gradeBuild({ evalCase, events: log(), targets, extras: record });
    expect(grade.checks.find((c) => c.kind === "qa_complete")?.passed).toBe(false);
    expect(grade.missionMetrics.answerAccuracy).toBe(1);
    expect(grade.hardFailures).toEqual([]);
  });

  it("fails without an assistant and asks nothing", async () => {
    const empty = await collectAnswers(
      {
        evalCase,
        events: log({ nope: true }),
        env: {},
        audience: "public-demo",
        sleep: () => Promise.resolve(),
        now: () => new Date(0),
        answer: () => Promise.reject(new Error("must not be asked")),
        log: () => undefined,
      },
      {},
    );
    expect(empty).toMatchObject({ assistantId: null, answers: [] });
    const grade = gradeBuild({ evalCase, events: log({ nope: true }), targets, extras: empty });
    expect(grade.hardFailures).toContain("schema_valid");
    expect(grade.citationsVerified).toBeNull();
  });

  it("renders expected answers and marks out-of-scope questions for the judge", async () => {
    const text = renderBuildJudgeInput(evalCase, fixtureAssistant(evalCase), await qa());
    expect(text).toContain(evalCase.questions[0]?.expectedAnswer ?? "?");
    expect(text).toContain("out of scope: must be declined");
    expect(text).toContain("Assistant refused");
  });
});
