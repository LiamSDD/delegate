import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { EVAL_MISSIONS, missionAdapter } from "../missions";
import { loadEvalPrompt } from "../judge/rubric-judge";
import { parseAuditDataset } from "./audit";
import { parseBuildDataset } from "./build";
import { datasetFile } from "./jsonl";

const TODAY_OR_EARLIER = (date: string) => date <= "2026-11-25";

describe("every mission dataset", () => {
  it.each(EVAL_MISSIONS)("%s has at least 8 cases, unique ids and a gate slice", (mission) => {
    const adapter = missionAdapter(mission);
    const cases = adapter.loadCases();
    expect(cases.length).toBeGreaterThanOrEqual(8);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    expect(cases.some((c) => c.tags.includes("gate"))).toBe(true);
    const changelog = readFileSync(datasetFile(adapter.dataset, "CHANGELOG.md"), "utf8");
    expect(changelog).toContain(`## v${adapter.dataset.version}`);
  });

  it.each(EVAL_MISSIONS)("%s has a versioned judge prompt with the rubric criteria", (mission) => {
    const adapter = missionAdapter(mission);
    const prompt = loadEvalPrompt(adapter.judge.promptFile);
    expect(prompt.version).toBeGreaterThanOrEqual(1);
    for (const criterion of adapter.judge.criteria) expect(prompt.body).toContain(criterion);
  });
});

describe("automation-audit v1", () => {
  const source = readFileSync(datasetFile({ name: "automation-audit" }, "v1.jsonl"), "utf8");
  const cases = parseAuditDataset(source);

  it("records a verification date on every hint", () => {
    for (const c of cases)
      for (const hint of [...c.hints.departments, ...c.hints.workflows])
        expect([c.id, hint.id, TODAY_OR_EARLIER(hint.verifiedAt)]).toEqual([c.id, hint.id, true]);
  });

  it("rejects duplicate ids, uppercase terms and invalid inputs", () => {
    const [line = ""] = source.split("\n");
    expect(() => parseAuditDataset(`${line}\n${line}`)).toThrow(/Duplicate/);
    const upper = line.replace(
      /"terms": \["([a-z])/,
      (_m, first: string) => `"terms": ["${first.toUpperCase()}`,
    );
    expect(() => parseAuditDataset(upper)).toThrow(/lowercase/);
    const http = line.replace('"url": "https://', '"url": "ftp://');
    expect(() => parseAuditDataset(http)).toThrow(/invalid/);
  });
});

describe("build-agent v1", () => {
  const source = readFileSync(datasetFile({ name: "build-agent" }, "v1.jsonl"), "utf8");
  const cases = parseBuildDataset(source);

  it("has 6 to 10 verified questions and exactly 3 out-of-scope questions per site", () => {
    for (const c of cases) {
      expect(c.questions.length).toBeGreaterThanOrEqual(6);
      expect(c.questions.length).toBeLessThanOrEqual(10);
      expect(c.outOfScope).toHaveLength(3);
      for (const q of c.questions) {
        expect(TODAY_OR_EARLIER(q.verifiedAt)).toBe(true);
        for (const term of q.mustInclude)
          expect([c.id, q.id, q.expectedAnswer.toLowerCase().includes(term.toLowerCase())]).toEqual(
            [c.id, q.id, true],
          );
      }
    }
  });

  it("rejects answers sourced from another site", () => {
    const [line = ""] = source.split("\n");
    const offSite = line.replace(
      /"sourceUrl": "https:\/\/[^/"]+/,
      '"sourceUrl": "https://elsewhere.example',
    );
    expect(() => parseBuildDataset(offSite)).toThrow(/crawled site/);
  });
});
