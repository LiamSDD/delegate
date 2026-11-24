import { describe, expect, it } from "vitest";

import { loadXrayDataset } from "../datasets/xray";
import { fixtureBrief } from "../testing/xray-fixture";
import {
  JudgeOutputError,
  judgeXray,
  loadJudgePrompt,
  normalisedJudgeScores,
  type JudgeCompleter,
} from "./xray-judge";

const verdict = {
  accuracy: { score: 4, rationale: "Matches founding year." },
  specificity: { score: "5", rationale: "Names products." },
  actionability: { score: 3, rationale: "Thin SWOT." },
  citationFaithfulness: { score: 5, rationale: "Quotes support claims." },
  facts: [{ id: "founded-2002", verdict: "supported" }],
};

function fakeCompleter(replies: string[]): JudgeCompleter & { users: string[] } {
  const users: string[] = [];
  return {
    users,
    complete(request) {
      users.push(request.messages.at(-1)?.content ?? "");
      const text = replies[users.length - 1];
      if (text === undefined) return Promise.reject(new Error("no reply scripted"));
      return Promise.resolve({ text, provider: "fake", model: "judge" });
    },
  };
}

const [atlassian] = loadXrayDataset();
if (atlassian === undefined) throw new Error("dataset empty");
const prompt = loadJudgePrompt();

describe("judgeXray", () => {
  it("parses a fenced verdict and records the prompt version", async () => {
    const completer = fakeCompleter([`Here:\n\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\``]);
    const result = await judgeXray({
      completer,
      prompt,
      evalCase: atlassian,
      brief: fixtureBrief(),
    });
    expect(result).toMatchObject({ provider: "fake", promptVersion: 1, repaired: false });
    expect(result.verdict.specificity.score).toBe(5);
    expect(normalisedJudgeScores(result.verdict)).toEqual({
      accuracy: 0.75,
      specificity: 1,
      actionability: 0.5,
      citationFaithfulness: 1,
    });
    expect(completer.users[0]).toContain("founded-2002");
    expect(completer.users[0]).toContain("[S1]");
  });

  it("repairs once with the validation issues, then gives up", async () => {
    const bad = JSON.stringify({ ...verdict, accuracy: { score: 9, rationale: "x" } });
    const repaired = fakeCompleter([bad, JSON.stringify(verdict)]);
    const result = await judgeXray({
      completer: repaired,
      prompt,
      evalCase: atlassian,
      brief: fixtureBrief(),
    });
    expect(result.repaired).toBe(true);
    expect(repaired.users[1]).toContain("accuracy.score");

    await expect(
      judgeXray({
        completer: fakeCompleter(["not json", "still not json"]),
        prompt,
        evalCase: atlassian,
        brief: fixtureBrief(),
      }),
    ).rejects.toBeInstanceOf(JudgeOutputError);
  });
});
