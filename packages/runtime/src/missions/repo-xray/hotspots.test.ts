import { describe, expect, it } from "vitest";

import { repoTarGz } from "../../testing/tarball";
import { analyseSnapshot } from "./analysis";
import { normaliseImprovements } from "./draft";
import { buildEvidence, lineCitation, type Evidence } from "./evidence";
import { buildHotspots, rankableHotspots } from "./hotspots";
import { formatCitation } from "./schema";
import { snapshotFromTarball } from "./snapshot";

const coordinates = { owner: "acme", repo: "widget", ref: "HEAD" };
const FIXTURE_TOKEN = ["refreshed", "token", "123"].join("-");
const AWS_KEY = ["AKIA", "Q7ZBXH2M4KTN6WRE"].join("");
const GITHUB_TOKEN = ["ghp", "_", "Zx81Qm4TfR0bWc6NpL2yKd9HvA3sJ7uE5gYo"].join("");

const HOOKS_TEST = [
  ...Array.from({ length: 40 }, (_, index) => `test('case ${index}', () => {});`),
  "server.get('/', (request, response) => {",
  `  response.json({error: {code: 'TOKEN_REFRESH', newToken: '${FIXTURE_TOKEN}'}});`,
  "});",
  "",
].join("\n");

const FILES = {
  "package.json": '{ "name": "widget", "version": "1.0.0" }\n',
  "src/index.ts": 'export * from "./config";\n',
  "src/config.ts": `export const region = "eu";\nexport const awsKey = "${AWS_KEY}";\n`,
  "src/github.ts": `const unused = 1;\nconst gh = "${GITHUB_TOKEN}";\n`,
  "src/session.ts": `export const session_secret = "${["supersecret", "password123"].join("")}";\n`,
  "test/hooks.ts": HOOKS_TEST,
  "fixtures/tokens.json": `{ "awsKey": "${AWS_KEY}" }\n`,
};

async function analysed() {
  const snapshot = await snapshotFromTarball(repoTarGz("widget-1", FILES), coordinates);
  const analysis = analyseSnapshot(snapshot);
  return { snapshot, analysis, hotspots: buildHotspots(snapshot, analysis) };
}

describe("secret-like hotspots", () => {
  it("records confidence per finding with the line inside its own file", async () => {
    const { snapshot } = await analysed();
    const byPath = Object.fromEntries(
      snapshot.secrets.map((secret) => [secret.path, secret] as const),
    );
    expect(byPath["test/hooks.ts"]).toEqual({
      kind: "generic-assignment",
      path: "test/hooks.ts",
      line: 42,
      confidence: "low",
      reason: "fixture-path",
    });
    expect(byPath["src/config.ts"]).toEqual({
      kind: "aws-access-key",
      path: "src/config.ts",
      line: 2,
      confidence: "high",
    });
    expect(byPath["src/session.ts"]).toMatchObject({
      confidence: "low",
      reason: "placeholder-value",
    });
    expect(byPath["fixtures/tokens.json"]).toMatchObject({
      confidence: "low",
      reason: "fixture-path",
    });
  });

  it("ranks real provider tokens in production paths first and fixture tokens last, together", async () => {
    const { hotspots } = await analysed();
    const secrets = hotspots.filter((hotspot) => hotspot.kind === "secret-like");
    expect(
      secrets.map((hotspot) => [hotspot.severity, hotspot.citations.map(formatCitation)]),
    ).toEqual([
      ["high", ["src/config.ts:2"]],
      ["high", ["src/github.ts:2"]],
      ["low", ["src/session.ts:1", "test/hooks.ts:42", "fixtures/tokens.json:1"]],
    ]);
    expect(hotspots[0]?.title).toBe("Secret-like value committed in src/config.ts");
    const fixtures = secrets.at(-1);
    expect(fixtures?.title).toBe("Test fixture tokens, verify not real (3 values in 3 files)");
    expect(hotspots.at(-1)).toBe(fixtures);
  });

  it("keeps fixture tokens out of the evidence the improver ranks from", async () => {
    const { snapshot, analysis, hotspots } = await analysed();
    const evidence = buildEvidence(
      snapshot,
      analysis,
      rankableHotspots(hotspots).flatMap((hotspot) =>
        hotspot.citations[0] === undefined
          ? []
          : [{ title: hotspot.title, detail: hotspot.detail, citation: hotspot.citations[0] }],
      ),
      [],
    );
    const texts = evidence.filter((item) => item.kind === "hotspot").map((item) => item.text);
    expect(texts.some((text) => text.includes("src/config.ts"))).toBe(true);
    expect(texts.some((text) => /fixture tokens|test\/hooks\.ts/i.test(text))).toBe(false);
  });
});

describe("normaliseImprovements and fixture tokens", () => {
  it("never ranks rotating a secret that lives only in test or fixture files", async () => {
    const { snapshot } = await analysed();
    const evidence = new Map<string, Evidence>([
      [
        "E1",
        {
          id: "E1",
          kind: "hotspot",
          citation: lineCitation("src/config.ts", 2),
          text: "Secret-like value committed in src/config.ts",
          trust: "derived",
        },
      ],
    ]);
    const { improvements, issues } = normaliseImprovements(
      {
        improvements: [
          {
            title: "Rotate or remove secret-like value in test/hooks.ts",
            rationale: "A secret-like token was found committed in test/hooks.ts (E1).",
            cite: ["E1"],
            files: ["test/hooks.ts"],
            kind: "security",
            effort: "S",
            acceptance: ["The token is removed"],
          },
          {
            title: "Move the AWS key in src/config.ts to the environment",
            rationale: "E1 shows an AWS access key format committed in src/config.ts.",
            cite: ["E1"],
            files: ["src/config.ts"],
            kind: "security",
            effort: "S",
            acceptance: ["src/config.ts reads the key from process.env"],
          },
        ],
      },
      evidence,
      snapshot,
    );
    expect(improvements.map((improvement) => improvement.files)).toEqual([["src/config.ts"]]);
    expect(issues.fixtureSecrets).toEqual(["Rotate or remove secret-like value in test/hooks.ts"]);
  });
});
