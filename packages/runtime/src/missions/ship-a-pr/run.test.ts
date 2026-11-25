import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { posix } from "node:path";

import { shipConnectedPolicy, shipDemoPolicy, shipOwnerPolicy } from "@delegate/policy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createRunContext, type Audience } from "../../agent/context";
import { createRunEmitter } from "../../agent/emitter";
import { Budget } from "../../budget";
import { foldRun, parseRunEvent, type RunEvent, type RunEventDraft } from "../../events";
import { createGitHubAppClient, readGitHubAppConfig, type GitHubAppClient } from "../../github/app";
import { loadPrompt } from "../../server";
import { createLocalSandboxProvider } from "../../sandbox/local";
import { type ModelRequest, type ModelStreamEvent } from "../../providers/types";
import { createFixtureRepo, FIXED_SUM, SUM_FIXTURE } from "../../testing/fixture-repo";
import { TEST_MODELS_CONFIG, scriptedProvider, textTurn, toolTurn } from "../../testing/fakes";
import { type ShipAPrInput } from "./input";
import { runShipAPr, type FindInstallation } from "./run";
import { ShipResultSchema, type AwaitShipApproval, type ShipDecision } from "./schema";

const NOW = Date.parse("2026-11-25T10:00:00Z");
const TOKEN = ["ghs", "fixturetoken0123456789abcdef"].join("_");
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" });

let fixture: string;
let sandboxRoot: string;

beforeAll(async () => {
  fixture = await createFixtureRepo(SUM_FIXTURE);
  sandboxRoot = await realpath(await mkdtemp(posix.join(tmpdir(), "delegate-ship-sandboxes-")));
});

afterAll(async () => {
  await rm(fixture, { recursive: true, force: true });
  await rm(sandboxRoot, { recursive: true, force: true });
});

const input: ShipAPrInput = {
  repoUrl: "https://github.com/acme/widgets",
  improvement: {
    id: "imp-1",
    title: "Make sum handle empty lists",
    rationale: "sum([]) throws a TypeError because reduce has no initial value.",
    files: ["src/sum.js"],
    kind: "bugfix",
    effort: "S",
    acceptance: ["sum([]) returns 0", "Existing tests still pass"],
  },
};

function engineerScript() {
  return scriptedProvider("fake", (request: ModelRequest, index: number): ModelStreamEvent[] => {
    if (request.model !== "fake-worker") return textTurn("{}");
    const turns: ModelStreamEvent[][] = [
      toolTurn([{ id: "c1", name: "read_file", args: { path: "src/sum.js" } }]),
      toolTurn([
        { id: "c2", name: "write_file", args: { path: "src/sum.js", content: FIXED_SUM } },
      ]),
      toolTurn([{ id: "c3", name: "run", args: { command: "test" } }]),
      textTurn("Gave reduce an initial value of 0 so sum([]) returns 0; tests pass."),
    ];
    return turns[Math.min(index, turns.length - 1)] ?? textTurn("Done.");
  });
}

interface GitHubCall {
  method: string;
  path: string;
  body: unknown;
}

function fakeGitHub(installed: boolean, permission = "write") {
  const calls: GitHubCall[] = [];
  const sha = (char: string) => char.repeat(40);
  const fetchImpl: typeof fetch = (request, init) => {
    const url = new URL(request instanceof Request ? request.url : request);
    const method = init?.method ?? "GET";
    calls.push({
      method,
      path: url.pathname,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const reply = (status: number, body: unknown) =>
      Promise.resolve(new Response(JSON.stringify(body), { status }));
    const key = `${method} ${url.pathname}`;
    if (key === "GET /repos/acme/widgets/installation")
      return installed ? reply(200, { id: 7 }) : reply(404, { message: "Not Found" });
    if (key === "POST /app/installations/7/access_tokens") return reply(201, { token: TOKEN });
    if (key === "GET /repos/acme/widgets") return reply(200, { default_branch: "main" });
    if (key === "GET /repos/acme/widgets/collaborators/octo-visitor/permission")
      return reply(200, { permission, role_name: permission, user: { login: "octo-visitor" } });
    if (method === "GET" && url.pathname.startsWith("/repos/acme/widgets/git/commits/"))
      return reply(200, { sha: sha("1"), tree: { sha: sha("2") } });
    if (key === "POST /repos/acme/widgets/git/blobs") return reply(201, { sha: sha("3") });
    if (key === "POST /repos/acme/widgets/git/trees") return reply(201, { sha: sha("4") });
    if (key === "POST /repos/acme/widgets/git/commits") return reply(201, { sha: sha("5") });
    if (key === "POST /repos/acme/widgets/git/refs") return reply(201, {});
    if (key === "POST /repos/acme/widgets/pulls")
      return reply(201, { number: 42, html_url: "https://github.com/acme/widgets/pull/42" });
    return reply(404, { message: "Not Found" });
  };
  const config = readGitHubAppConfig({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: pem });
  if (config === null) throw new Error("config expected");
  const client: GitHubAppClient = createGitHubAppClient({
    config,
    fetch: fetchImpl,
    now: () => NOW,
  });
  return { calls, client };
}

async function ship(options: {
  audience: Audience;
  github: GitHubAppClient | null;
  connected?: FindInstallation;
  decision?: ShipDecision;
  approval?: AwaitShipApproval;
}) {
  const drafts: RunEventDraft[] = [];
  const provider = engineerScript();
  const ctx = createRunContext({
    runId: "run_ship",
    workspaceId: "ws_1",
    audience: options.audience,
    classification: "public",
    config: TEST_MODELS_CONFIG,
    env: {},
    emitter: createRunEmitter((event) => {
      drafts.push(event);
      return Promise.resolve();
    }),
    budget: new Budget({ run: { maxTokens: 1_000_000, maxMicroUsd: 0 }, steps: {} }),
    policies: [
      options.audience === "owner"
        ? shipOwnerPolicy
        : options.connected === undefined
          ? shipDemoPolicy
          : shipConnectedPolicy,
    ],
    createProvider: () => provider,
    now: () => new Date(),
  });
  const requests: Parameters<AwaitShipApproval>[0][] = [];
  const approval: AwaitShipApproval | undefined =
    options.approval ??
    (options.decision === undefined
      ? undefined
      : (
          (decision: ShipDecision): AwaitShipApproval =>
          (request) => {
            requests.push(request);
            return Promise.resolve(decision);
          }
        )(options.decision));
  const status = await runShipAPr({
    ctx,
    input,
    prompts: {
      planner: loadPrompt("planner.v2.md"),
      engineer: loadPrompt("ship-a-pr.engineer.v1.md"),
    },
    sandboxes: createLocalSandboxProvider({ root: sandboxRoot }),
    github: options.github,
    ...(options.connected === undefined ? {} : { findInstallation: options.connected }),
    cloneUrl: () => fixture,
    ...(approval === undefined ? {} : { awaitShipApproval: approval }),
  });
  const events: RunEvent[] = [
    parseRunEvent({
      runId: "run_ship",
      seq: 1,
      at: new Date(NOW).toISOString(),
      type: "run.created",
      payload: {
        workspaceId: "ws_1",
        missionId: "ship-a-pr",
        input,
        actor: { type: "guest", id: "g1" },
        budget: { maxTokens: 1_000_000, maxMicroUsd: 0 },
      },
    }),
    ...drafts.map((draft, index) =>
      parseRunEvent({ ...draft, seq: index + 2, at: new Date(NOW + index).toISOString() }),
    ),
  ];
  const result = drafts
    .flatMap((event) =>
      event.type === "artifact.created" && event.payload.kind === "ship-result"
        ? [ShipResultSchema.parse(event.payload.content)]
        : [],
    )
    .at(-1);
  return { status, drafts, events, state: foldRun(events), result, requests, provider };
}

function writes(calls: readonly GitHubCall[]): GitHubCall[] {
  return calls.filter((call) => call.method === "POST" && call.path.startsWith("/repos/"));
}

describe("Ship-a-PR mission", { timeout: 60_000 }, () => {
  it("fixes a failing test, records before/after results and opens a PR after approval", async () => {
    const github = fakeGitHub(true);
    const run = await ship({
      audience: "owner",
      github: github.client,
      decision: { decision: "approved", approvedBy: { type: "member", id: "owner" } },
    });
    expect(run.status).toBe("completed");
    expect(run.state.status).toBe("completed");
    expect(run.state.steps.map((step) => step.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    const approval = run.requests[0];
    expect(approval?.mode).toBe("pull_request");
    expect(approval?.baseline.passed).toBe(false);
    expect(approval?.after.passed).toBe(true);
    expect(approval?.diffStat).toEqual({ files: 1, additions: 1, deletions: 1 });
    expect(run.state.ship?.approval?.status).toBe("approved");
    expect(run.state.ship?.pullRequest?.url).toBe("https://github.com/acme/widgets/pull/42");
    expect(run.result?.status).toBe("opened");

    const blob = writes(github.calls).find((call) => call.path.endsWith("/git/blobs"));
    expect(
      Buffer.from((blob?.body as { content: string }).content, "base64").toString("utf8"),
    ).toBe(FIXED_SUM);
    const pull = writes(github.calls).find((call) => call.path.endsWith("/pulls"));
    expect((pull?.body as { head: string }).head).toMatch(/^delegate\/imp-1-[0-9a-f]{7}$/);
    expect(pull?.body).toMatchObject({
      base: "main",
      title: "Make sum handle empty lists",
    });
    const body = (pull?.body as { body: string }).body;
    expect(body).toContain("- [ ] sum([]) returns 0");
    expect(body).toContain("| Tests | `npm run test` | failed");
    expect(body).toContain("Produced by Delegate");

    const log = JSON.stringify(run.events);
    expect(log).not.toContain(TOKEN);
    expect(log).not.toContain("BEGIN RSA PRIVATE KEY");
    const purposes = run.drafts.flatMap((event) =>
      event.type === "sandbox.command" ? [event.payload.purpose] : [],
    );
    expect(purposes).toEqual(
      expect.arrayContaining(["clone", "install", "baseline", "engineer", "verify"]),
    );
    const requireApproval = run.drafts.find(
      (event) => event.type === "policy.decided" && event.payload.tool === "github.open_pr",
    );
    expect(requireApproval?.type === "policy.decided" && requireApproval.payload.decision).toBe(
      "require_approval",
    );
    const approvalSeq = run.events.findIndex((event) => event.type === "ship.approval.decided");
    const firstWrite = run.events.findIndex(
      (event) => event.type === "tool.called" && event.payload.tool === "github.open_pr",
    );
    expect(firstWrite).toBeGreaterThan(approvalSeq);
  });

  it("pushes the approved bytes even when the sandbox changes during the approval window", async () => {
    const github = fakeGitHub(true);
    const live: string[] = [];
    const run = await ship({
      audience: "owner",
      github: github.client,
      approval: async () => {
        for (const entry of await readdir(sandboxRoot)) {
          const target = posix.join(sandboxRoot, entry, "repo", "src", "sum.js");
          const exists = await stat(target).then(
            () => true,
            () => false,
          );
          if (!exists) continue;
          live.push(target);
          await writeFile(target, "module.exports = () => 'tampered';\n");
        }
        return { decision: "approved", approvedBy: { type: "member", id: "owner" } };
      },
    });
    expect(live).toEqual([]);
    expect(run.result?.status).toBe("opened");
    const blob = writes(github.calls).find((call) => call.path.endsWith("/git/blobs"));
    expect(
      Buffer.from((blob?.body as { content: string }).content, "base64").toString("utf8"),
    ).toBe(FIXED_SUM);
  });

  it("opens no PR and pushes nothing when the reviewer rejects", async () => {
    const github = fakeGitHub(true);
    const run = await ship({
      audience: "owner",
      github: github.client,
      decision: { decision: "rejected", reason: "Not now" },
    });
    expect(run.status).toBe("completed");
    expect(writes(github.calls)).toEqual([]);
    expect(run.result).toMatchObject({ status: "rejected", reason: "Not now" });
    expect(run.result?.patch).toBeUndefined();
    expect(run.state.ship?.pullRequest).toBeUndefined();
  });

  it("treats a missing reviewer as a rejection", async () => {
    const github = fakeGitHub(true);
    const run = await ship({ audience: "owner", github: github.client });
    expect(writes(github.calls)).toEqual([]);
    expect(run.result?.status).toBe("rejected");
    expect(run.state.ship?.approval?.status).toBe("rejected");
  });

  it("gives public demo visitors only a patch, without asking GitHub at all", async () => {
    const github = fakeGitHub(true);
    const run = await ship({
      audience: "public-demo",
      github: github.client,
      decision: { decision: "approved" },
    });
    expect(github.calls).toEqual([]);
    expect(run.requests[0]?.mode).toBe("patch");
    expect(run.result?.status).toBe("patch_ready");
    expect(run.result?.testReport).toContain("| Tests | `npm run test` | failed");
    const patch = run.result?.patch;
    expect(patch?.fileName).toBe("imp-1.patch");
    const check = posix.join(fixture, "check.patch");
    await writeFile(check, patch?.content ?? "");
    try {
      execFileSync("git", ["apply", "--check", check], { cwd: fixture, stdio: "pipe" });
    } finally {
      await rm(check);
    }
    expect(await readFile(posix.join(fixture, "src/sum.js"), "utf8")).not.toBe(FIXED_SUM);
  });

  it("opens a real PR for a visitor whose own connected installation covers the repository", async () => {
    const github = fakeGitHub(false);
    const asked: string[] = [];
    const run = await ship({
      audience: "public-demo",
      github: github.client,
      connected: (owner, repo) => {
        asked.push(`${owner}/${repo}`);
        return Promise.resolve({ installationId: 7, collaborator: "octo-visitor" });
      },
      decision: { decision: "approved", approvedBy: { type: "guest", id: "visitor" } },
    });
    expect(asked).toEqual(["acme/widgets"]);
    expect(run.requests[0]?.mode).toBe("pull_request");
    expect(github.calls.map((call) => call.path)).toContain(
      "/repos/acme/widgets/collaborators/octo-visitor/permission",
    );
    expect(github.calls.map((call) => call.path)).not.toContain("/repos/acme/widgets/installation");
    expect(github.calls[0]?.path).toBe("/app/installations/7/access_tokens");
    expect(run.result?.status).toBe("opened");
    expect(JSON.stringify(run.events)).not.toContain(TOKEN);
  });

  it("gives a connected visitor a patch when the connecting GitHub user cannot push to the repository", async () => {
    const github = fakeGitHub(false, "read");
    const run = await ship({
      audience: "public-demo",
      github: github.client,
      connected: () => Promise.resolve({ installationId: 7, collaborator: "octo-visitor" }),
      decision: { decision: "approved" },
    });
    expect(run.requests[0]?.mode).toBe("patch");
    expect(run.requests[0]?.reason).toContain(
      "@octo-visitor (who connected GitHub) does not have push access",
    );
    expect(writes(github.calls).filter((call) => call.path.startsWith("/repos/"))).toEqual([]);
    expect(run.result?.status).toBe("patch_ready");
  });

  it("gives a connected visitor a patch when the installation has no recorded GitHub user", async () => {
    const github = fakeGitHub(false);
    const run = await ship({
      audience: "public-demo",
      github: github.client,
      connected: () => Promise.resolve({ installationId: 7, collaborator: null }),
      decision: { decision: "approved" },
    });
    expect(github.calls).toEqual([]);
    expect(run.requests[0]?.mode).toBe("patch");
    expect(run.requests[0]?.reason).toContain("reconnect GitHub");
  });

  it("gives a connected visitor a patch when their installation does not cover the repository", async () => {
    const github = fakeGitHub(true);
    const run = await ship({
      audience: "public-demo",
      github: github.client,
      connected: () => Promise.resolve(null),
      decision: { decision: "approved" },
    });
    expect(github.calls).toEqual([]);
    expect(run.requests[0]?.mode).toBe("patch");
    expect(run.requests[0]?.reason).toContain("No GitHub installation connected");
  });

  it("falls back to a patch when the GitHub App is not installed on the repository", async () => {
    const github = fakeGitHub(false);
    const run = await ship({
      audience: "owner",
      github: github.client,
      decision: { decision: "approved" },
    });
    expect(writes(github.calls)).toEqual([]);
    expect(run.requests[0]?.mode).toBe("patch");
    expect(run.requests[0]?.reason).toContain("not installed on acme/widgets");
    expect(run.result?.status).toBe("patch_ready");
  });
});
