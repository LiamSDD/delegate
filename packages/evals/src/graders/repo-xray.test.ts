import { type RunEvent, type RunEventDraft, parseRunEvent } from "@delegate/runtime";
import { createFetcher } from "@delegate/runtime/security";
import { archiveUrl, loadPrompt, runRepoXray } from "@delegate/runtime/server";
import { RepoXrayInputSchema, RepoXraySchema, type RepoXray } from "@delegate/runtime";
import {
  repoTarGz,
  scriptedProvider,
  testRun,
  textTurn,
  type ScriptedProvider,
} from "@delegate/runtime/testing";
import { describe, expect, it } from "vitest";

import { loadRepoXrayDataset, type RepoXrayCase } from "../datasets/repo-xray";
import { gradeRepoXray, repoArtifacts } from "./repo-xray";

const FILES: Record<string, string> = {
  "README.md": "# kite\n\nkite turns text into tokens.\n",
  "package.json": `${JSON.stringify(
    {
      name: "kite",
      main: "index.js",
      scripts: { test: "node --test" },
      dependencies: { ms: "^2.1.3" },
    },
    null,
    2,
  )}\n`,
  "index.js": 'const { tokenize } = require("./tokenize");\n\nmodule.exports = { tokenize };\n',
  "tokenize.js":
    'function tokenize(text) {\n  return text.split(" ");\n}\n\nfunction run(code) {\n  return eval(code);\n}\n\nmodule.exports = { tokenize, run };\n',
  "format.js":
    'const { tokenize } = require("./tokenize");\n\nfunction format(text) {\n  return tokenize(text).join(",");\n}\n\nmodule.exports = { format };\n',
  "test/tokenize.test.js":
    'const test = require("node:test");\nconst { tokenize } = require("../tokenize");\n\ntest("splits", () => tokenize("a b"));\n',
  ".github/workflows/ci.yml": "jobs:\n  test:\n    steps:\n      - run: npm test\n",
};

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

function ids(prompt: string, kind: string): string[] {
  return prompt
    .split("\n")
    .filter((line) => line.startsWith('{"id":"E') && line.includes(`"kind":"${kind}"`))
    .map((line) => (JSON.parse(line) as { id: string }).id);
}

function provider(): ScriptedProvider {
  return scriptedProvider("fake", (request) => {
    const user = request.messages
      .map((message) => (message.role === "user" ? message.content : ""))
      .join("\n");
    if (request.system.includes("architect on a Repo X-ray"))
      return textTurn(
        JSON.stringify({
          summary: [
            { text: "index.js re-exports tokenize from tokenize.js.", cite: ids(user, "import") },
          ],
          diagram: {
            nodes: [{ module: "index.js" }, { module: "tokenize.js" }, { module: "format.js" }],
          },
          modules: [],
          onboarding: [],
        }),
      );
    if (request.system.includes("senior engineer proposing")) {
      const hotspot = ids(user, "hotspot");
      const improvement = (index: number) => ({
        title: `Improvement ${index}`,
        rationale: "tokenize.js calls eval on its argument.",
        cite: hotspot,
        files: ["tokenize.js"],
        kind: "security",
        effort: "S",
        acceptance: ["npm test passes"],
      });
      return textTurn(JSON.stringify({ improvements: [1, 2, 3, 4, 5].map(improvement) }));
    }
    if (request.system.includes("You are the critic")) {
      const claims = [...user.matchAll(/"id":"([^"]+)","claim"/g)].map((match) => match[1]);
      return textTurn(
        JSON.stringify({
          results: claims.map((id) => ({ id, atoms: [{ text: "a", verdict: "supported" }] })),
        }),
      );
    }
    return textTurn(JSON.stringify({ sources: [] }));
  });
}

async function runFixture(): Promise<RunEvent[]> {
  const archive = repoTarGz("kite-abc", FILES);
  const target = archiveUrl("acme", "kite", "HEAD");
  const fetcher = createFetcher({
    fetchImpl: (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return Promise.resolve(
        url === target
          ? new Response(archive, { headers: { "content-type": "application/x-gzip" } })
          : new Response("", { status: 404 }),
      );
    },
    resolveDns: () => Promise.resolve(["93.184.216.34"]),
    perHostIntervalMs: 0,
  });
  const { ctx, events } = testRun({ provider: provider() });
  await runRepoXray({
    ctx,
    input: RepoXrayInputSchema.parse({ url: CASE.input.url }),
    fetcher,
    prompts: {
      reader: loadPrompt("quarantine-reader.v1.md"),
      repoArchitect: loadPrompt("repo-xray.architect.v1.md"),
      repoImprover: loadPrompt("repo-xray.improver.v1.md"),
      planner: loadPrompt("planner.v2.md"),
      critic: loadPrompt("critic.v1.md"),
      editor: loadPrompt("editor.v1.md"),
    },
  });
  return events.map((event: RunEventDraft, index) =>
    parseRunEvent({ ...event, seq: index + 1, at: "2026-11-25T10:00:00.000Z" }),
  );
}

describe("repo-xray dataset v1", () => {
  it("parses five public repositories with verifiable facts", () => {
    const cases = loadRepoXrayDataset();
    expect(cases.map((entry) => entry.id)).toEqual([
      "ky",
      "commander",
      "click",
      "itsdangerous",
      "cobra",
    ]);
    for (const entry of cases) expect(entry.expectedFacts.length).toBeGreaterThanOrEqual(4);
  });
});

describe("gradeRepoXray", () => {
  it("passes a real mission output and reports which expected facts were found", async () => {
    const grade = gradeRepoXray(CASE, repoArtifacts(await runFixture()));
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
    const artifacts = repoArtifacts(await runFixture());
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
