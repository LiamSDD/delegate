import { RepoXraySchema, type RepoXray } from "@delegate/runtime";
import { describe, expect, it } from "vitest";

import {
  REPO_XRAY_DATASET_PATH,
  loadRepoXrayDataset,
  type RepoXrayCase,
} from "../datasets/repo-xray";
import { repoFixtureEvents } from "../testing/repo-fixture";
import { gradeRepoXray, repoArtifacts } from "./repo-xray";

const CASE: RepoXrayCase = {
  id: "kite",
  mission: "repo-xray",
  version: 1,
  input: { url: "https://github.com/acme/kite" },
  repo: { owner: "acme", name: "kite", language: "JavaScript", size: "small" },
  expectedFacts: [
    {
      id: "lang",
      kind: "language",
      value: "JavaScript",
      proposition: "Most code is JavaScript.",
      sourceUrl: "https://github.com/acme/kite",
      verifiedAt: "2026-11-25",
    },
    {
      id: "tests",
      kind: "test-framework",
      value: "node:test",
      proposition: "Tests use node:test.",
      sourceUrl: "https://github.com/acme/kite",
      verifiedAt: "2026-11-25",
    },
    {
      id: "dep",
      kind: "dependency",
      value: "ms",
      proposition: "It depends on ms.",
      sourceUrl: "https://github.com/acme/kite",
      verifiedAt: "2026-11-25",
    },
    {
      id: "ci",
      kind: "ci",
      value: "CircleCI",
      proposition: "CI runs on CircleCI.",
      sourceUrl: "https://github.com/acme/kite",
      verifiedAt: "2026-11-25",
    },
  ],
  tags: [],
};

describe("repo-xray datasets", () => {
  it("v2 adds a Rust crate, a monorepo and a large repository to the five v1 cases", () => {
    const v1 = loadRepoXrayDataset(REPO_XRAY_DATASET_PATH.replace("v2.jsonl", "v1.jsonl"));
    const v2 = loadRepoXrayDataset();
    expect(v1.map((entry) => entry.id)).toEqual([
      "ky",
      "commander",
      "click",
      "itsdangerous",
      "cobra",
    ]);
    expect(v2.map((entry) => entry.id)).toEqual([
      ...v1.map((entry) => entry.id),
      "anyhow",
      "changesets",
      "fastapi",
    ]);
    for (const entry of v2) {
      expect(entry.version).toBe(2);
      expect(entry.expectedFacts.length).toBeGreaterThanOrEqual(4);
      for (const fact of entry.expectedFacts) expect(fact.verifiedAt).toMatch(/^2026-/);
    }
  });
});

describe("gradeRepoXray", () => {
  it("passes a real mission output and reports which expected facts were found", async () => {
    const grade = gradeRepoXray(CASE, repoArtifacts(await repoFixtureEvents()));
    expect(grade.checks.map((check) => [check.kind, check.passed])).toEqual([
      ["schema_valid", true],
      ["citations_resolve", true],
      ["mermaid_nodes_real", true],
      ["improvements_valid", true],
      ["expected_facts", false],
    ]);
    expect(grade.facts.map((fact) => [fact.id, fact.found])).toEqual([
      ["lang", true],
      ["tests", true],
      ["dep", true],
      ["ci", false],
    ]);
    expect(grade.passed).toBe(true);
  });

  it("fails citations to missing lines, fake diagram nodes and malformed improvements", async () => {
    const artifacts = repoArtifacts(await repoFixtureEvents());
    const xray: RepoXray = RepoXraySchema.parse(artifacts.xray);
    const diagram = xray.architecture.diagram;
    if (diagram === null) throw new Error("expected a diagram");
    const forged: RepoXray = {
      ...xray,
      architecture: {
        ...xray.architecture,
        summary: [
          { text: "Forged.", citations: [{ path: "index.js", startLine: 90, endLine: 91 }] },
        ],
        diagram: {
          ...diagram,
          mermaid: `${diagram.mermaid}\n  m9["src/ghost"]`,
          nodes: [...diagram.nodes, { id: "m9", module: "src/ghost" }],
        },
      },
      improvements: xray.improvements.slice(0, 2),
    };
    const grade = gradeRepoXray(CASE, { ...artifacts, xray: forged });
    expect(grade.checks.filter((check) => !check.passed).map((check) => check.kind)).toEqual([
      "citations_resolve",
      "mermaid_nodes_real",
      "improvements_valid",
      "expected_facts",
    ]);
    expect(grade.checks.find((check) => check.kind === "citations_resolve")?.detail).toContain(
      "index.js:90-91",
    );
    expect(grade.passed).toBe(false);
    expect(gradeRepoXray(CASE, { xray: undefined, snapshot: undefined }).passed).toBe(false);
  });
});
