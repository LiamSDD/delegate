import {
  parseRunEvent,
  RepoXrayInputSchema,
  type RunEvent,
  type RunEventDraft,
} from "@delegate/runtime";
import { createFetcher } from "@delegate/runtime/security";
import { archiveUrl, loadPrompt, runRepoXray } from "@delegate/runtime/server";
import {
  repoTarGz,
  scriptedProvider,
  testRun,
  textTurn,
  type ScriptedProvider,
} from "@delegate/runtime/testing";

export const REPO_FIXTURE_FILES: Record<string, string> = {
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

export async function repoFixtureEvents(url = "https://github.com/acme/kite"): Promise<RunEvent[]> {
  const [owner = "acme", repo = "kite"] = new URL(url).pathname.split("/").filter(Boolean);
  const archive = repoTarGz(`${repo}-abc`, REPO_FIXTURE_FILES);
  const target = archiveUrl(owner, repo, "HEAD");
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
    input: RepoXrayInputSchema.parse({ url }),
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
