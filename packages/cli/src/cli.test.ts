import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { IDEMPOTENCY_KEY_HEADER, type Run } from "@delegate/sdk";
import { afterEach, describe, expect, it } from "vitest";

import { HELP, OPTIONS, runCli } from "./cli";
import { configPath, CONFIG_ENV, TOKEN_ENV, URL_ENV } from "./config";
import { EXIT, EXIT_MEANINGS } from "./exit-codes";
import { nodeFiles } from "./node-io";
import {
  createFakeApi,
  createTestIo,
  FAKE_ORIGIN,
  FAKE_TOKEN,
  type FakeApi,
  type TestIo,
} from "./testing";

const ESC = String.fromCharCode(27);

function session(api: FakeApi, overrides: Parameters<typeof createTestIo>[0] = {}): TestIo {
  return createTestIo({
    env: { [TOKEN_ENV]: FAKE_TOKEN, [URL_ENV]: FAKE_ORIGIN },
    fetch: api.fetch,
    ...overrides,
  });
}

function playRepoXray(api: FakeApi, run: Run, outcome: "completed" | "failed" | "cancelled") {
  api.emit(run.id, "run.created", { missionId: "repo-xray" });
  api.emit(run.id, "plan.proposed", {
    version: 1,
    steps: [
      { id: "map", objective: "Map the architecture" },
      { id: "risks", objective: "Find risk hotspots" },
    ],
  });
  api.emit(run.id, "plan.approved", { version: 1, approvedBy: { type: "guest", id: "u1" } });
  api.emit(run.id, "step.started", {}, "map");
  api.emit(run.id, "tool.called", { tool: "repo_read", argsSummary: "README.md" }, "map");
  api.emit(
    run.id,
    "step.completed",
    { outcome: "succeeded", summary: "12 packages, 3 entry points", artifactIds: [] },
    "map",
  );
  api.emit(run.id, "approval.requested", {
    approvalId: "a1",
    policyId: "p1",
    reason: "write",
    summary: "tickets/update_record: close 14 tickets",
  });
  api.emit(run.id, "artifact.created", {
    artifactId: "repo-map",
    kind: "repo-xray",
    title: "Architecture map",
    version: 1,
  });
  if (outcome === "completed") {
    api.emit(run.id, "run.completed", { summary: "Mapped 12 packages." });
    api.setRun(run.id, {
      status: "completed",
      terminal: true,
      finishedAt: "2026-11-25T12:03:00.000Z",
      summary: "Mapped 12 packages.\nThree risk hotspots found.",
      totals: { inputTokens: 12_000, outputTokens: 3_400, costMicroUsd: 0, toolCalls: 41 },
      deliverable: {
        artifactId: "repo-map",
        kind: "repo-xray",
        title: "Architecture map",
        version: 1,
        content: { packages: 12 },
      },
    });
  } else {
    const error =
      outcome === "cancelled"
        ? { code: "cancelled", message: "cancelled by user" }
        : { code: "budget_exceeded", message: "The token budget ran out." };
    api.emit(run.id, "run.failed", { error });
    api.setRun(run.id, { status: "failed", terminal: true, error });
  }
}

describe("delegate: usage", () => {
  it("lists every parsed long option in the help text", () => {
    for (const option of Object.keys(OPTIONS)) {
      expect(HELP).toContain(`--${option}`);
    }
  });

  it("prints help and the version", async () => {
    const io = createTestIo();
    expect(await runCli(["--help"], io)).toBe(EXIT.ok);
    expect(io.text()).toBe(HELP);
    for (const command of [
      "login",
      "run <mission> <input> [--watch] [--json]",
      "runs list",
      "runs get",
      "runs events",
      "runs cancel",
      "approve-plan",
      "reject-plan",
      "artifacts get",
    ])
      expect(HELP).toContain(command);
    const version = createTestIo();
    expect(await runCli(["--version"], version)).toBe(EXIT.ok);
    expect(version.text()).toMatch(/^\d+\.\d+\.\d+\n$/);
  });

  it("documents every exit code in the help text", () => {
    for (const code of Object.values(EXIT)) expect(HELP).toMatch(new RegExp(`\\b${code} `));
    expect(Object.keys(EXIT_MEANINGS).sort()).toEqual(Object.keys(EXIT).sort());
    expect(new Set(Object.values(EXIT)).size).toBe(Object.values(EXIT).length);
  });

  it("keeps docs/guides/cli.md in step with the exit codes and commands", () => {
    const guide = readFileSync(
      fileURLToPath(new URL("../../../docs/guides/cli.md", import.meta.url)),
      "utf8",
    );
    const documented = [...guide.matchAll(/^\| (\d+) \| /gm)].map((match) => Number(match[1]));
    expect(documented).toEqual(Object.values(EXIT).sort((a, b) => a - b));
    for (const command of [
      "delegate login",
      "delegate logout",
      "delegate missions",
      "delegate run <mission> <input>",
      "delegate runs list",
      "delegate runs get <run-id>",
      "delegate runs events <run-id>",
      "delegate runs cancel <run-id>",
      "delegate approve-plan <run-id>",
      "delegate reject-plan <run-id>",
      "delegate artifacts list <run-id>",
      "delegate artifacts get <run-id> <artifact-id>",
    ]) {
      expect(guide, command).toContain(command);
      expect(HELP, command).toContain(command);
    }
    for (const variable of [TOKEN_ENV, URL_ENV, CONFIG_ENV]) expect(guide).toContain(variable);
  });

  it("exits 2 for unknown commands, unknown options and missing arguments", async () => {
    for (const argv of [
      [],
      ["frobnicate"],
      ["run"],
      ["run", "repo-xray"],
      ["run", "repo-xray", "a", "b"],
      ["run", "nope", "https://github.com/a/b"],
      ["run", "repo-xray", "https://github.com/a/b", "--bogus"],
      ["run", "repo-xray", "https://github.com/a/b", "--timeout", "soon"],
      ["run", "custom-goal", "Summarise the site", "--goal", "again"],
      ["runs"],
      ["runs", "delete", "x"],
      ["runs", "list", "--status", "done"],
      ["runs", "list", "--limit", "0"],
      ["runs", "events"],
      ["approve-plan"],
      ["approve-plan", "x", "--reason", "no"],
      ["artifacts", "get", "only-one"],
    ]) {
      const api = createFakeApi();
      const io = session(api);
      expect(await runCli(argv, io), argv.join(" ")).toBe(EXIT.usage);
      expect(api.requests, argv.join(" ")).toEqual([]);
    }
  });

  it("lists the missions with the flags each one takes", async () => {
    const io = createTestIo();
    expect(await runCli(["missions"], io)).toBe(EXIT.ok);
    expect(io.text()).toContain("delegate run repo-xray <url> --ref");
    expect(io.text()).toContain("delegate run build-agent <url> --goal (required)");
    expect(io.text()).toContain("delegate run autopilot <goal> --site");
  });
});

describe("delegate login", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("stores the token in a 0600 file and never prints it", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "delegate-cli-"));
    const file = path.join(dir, "nested", "config.json");
    const api = createFakeApi();
    const io = createTestIo({
      env: { [CONFIG_ENV]: file },
      fetch: api.fetch,
      files: nodeFiles,
      stdinIsTty: true,
      secret: `  ${FAKE_TOKEN}\n`,
    });
    expect(await runCli(["login", "--api-url", `${FAKE_ORIGIN}/some/path`], io)).toBe(EXIT.ok);
    expect(io.prompts).toEqual(["API token (input is hidden): "]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file))).mode & 0o077).toBe(0);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      version: 1,
      baseUrl: FAKE_ORIGIN,
      token: FAKE_TOKEN,
    });
    expect(io.text()).toContain(`Logged in to ${FAKE_ORIGIN}.`);
    expect(io.text()).toContain("mode 600");
    expect(io.text() + io.errors()).not.toContain(FAKE_TOKEN);
    expect(io.text() + io.errors()).not.toContain(FAKE_TOKEN.slice(4, 20));
    expect(api.requests).toHaveLength(1);

    const again = createTestIo({ env: { [CONFIG_ENV]: file }, fetch: api.fetch, files: nodeFiles });
    expect(await runCli(["runs", "list"], again)).toBe(EXIT.ok);
    expect(again.errors()).toBe("");

    const rewritten = createTestIo({
      env: { [CONFIG_ENV]: file },
      fetch: api.fetch,
      files: nodeFiles,
      stdin: FAKE_TOKEN,
    });
    expect(await runCli(["login", "--token-stdin"], rewritten)).toBe(EXIT.ok);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("reads the token from stdin when it is piped", async () => {
    const api = createFakeApi();
    const io = createTestIo({
      env: { [URL_ENV]: FAKE_ORIGIN },
      fetch: api.fetch,
      stdin: `${FAKE_TOKEN}\n`,
    });
    expect(await runCli(["login"], io)).toBe(EXIT.ok);
    expect(io.prompts).toEqual([]);
    expect(io.text() + io.errors()).not.toContain(FAKE_TOKEN);
  });

  it("stores nothing when the token is malformed or refused", async () => {
    const api = createFakeApi();
    const malformed = createTestIo({
      env: { [URL_ENV]: FAKE_ORIGIN },
      fetch: api.fetch,
      stdin: "hunter2",
    });
    expect(await runCli(["login"], malformed)).toBe(EXIT.auth);
    expect(api.requests).toEqual([]);
    expect(malformed.errors()).not.toContain("hunter2");
    const revoked = `dlg_${"r".repeat(43)}`;
    const refused = createTestIo({
      env: { [URL_ENV]: FAKE_ORIGIN },
      fetch: api.fetch,
      stdin: revoked,
    });
    expect(await runCli(["login"], refused)).toBe(EXIT.auth);
    expect(refused.errors()).toContain("did not accept the token");
    expect(refused.errors()).not.toContain(revoked);
    expect(await refused.files.read(configPath(refused))).toBeNull();
  });

  it("refuses a plain http deployment that is not localhost", async () => {
    const io = createTestIo({ stdin: FAKE_TOKEN });
    expect(await runCli(["login", "--api-url", "http://delegate.example"], io)).toBe(EXIT.usage);
    expect(io.errors()).toContain("https");
  });

  it("logs out by removing the file", async () => {
    const api = createFakeApi();
    const io = createTestIo({
      env: { [URL_ENV]: FAKE_ORIGIN },
      fetch: api.fetch,
      stdin: FAKE_TOKEN,
    });
    await runCli(["login"], io);
    expect(await runCli(["logout"], io)).toBe(EXIT.ok);
    expect(await io.files.read(configPath(io))).toBeNull();
    expect(await runCli(["runs", "list"], io)).toBe(EXIT.auth);
  });
});

describe("delegate: credentials", () => {
  it("exits 3 with a hint when there is no token", async () => {
    const api = createFakeApi();
    const io = createTestIo({ fetch: api.fetch });
    expect(await runCli(["runs", "list"], io)).toBe(EXIT.auth);
    expect(io.errors()).toContain("Not logged in");
    expect(io.errors()).toContain("delegate login");
    expect(api.requests).toEqual([]);
  });

  it("prefers DELEGATE_TOKEN over the stored token", async () => {
    const api = createFakeApi();
    const io = createTestIo({ fetch: api.fetch });
    await io.files.writePrivate(
      configPath(io),
      JSON.stringify({ version: 1, baseUrl: FAKE_ORIGIN, token: `dlg_${"o".repeat(43)}` }),
    );
    expect(await runCli(["runs", "list"], io)).toBe(EXIT.auth);
    io.env[TOKEN_ENV] = FAKE_TOKEN;
    expect(await runCli(["runs", "list"], io)).toBe(EXIT.ok);
    expect(api.requests.at(-1)?.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
  });

  it("never sends the stored token to a different deployment", async () => {
    const api = createFakeApi();
    const io = createTestIo({ fetch: api.fetch });
    await io.files.writePrivate(
      configPath(io),
      JSON.stringify({ version: 1, baseUrl: FAKE_ORIGIN, token: FAKE_TOKEN }),
    );
    expect(await runCli(["runs", "list", "--api-url", "https://evil.example"], io)).toBe(EXIT.auth);
    expect(io.errors()).toContain("it is not sent to https://evil.example");
    io.env[URL_ENV] = "https://evil.example";
    expect(await runCli(["runs", "list"], io)).toBe(EXIT.auth);
    expect(api.requests).toEqual([]);
  });

  it("warns when the config file is readable by others", async () => {
    const api = createFakeApi();
    const io = createTestIo({ fetch: api.fetch });
    await io.files.write(
      configPath(io),
      JSON.stringify({ version: 1, baseUrl: FAKE_ORIGIN, token: FAKE_TOKEN }),
    );
    expect(await runCli(["runs", "list"], io)).toBe(EXIT.ok);
    expect(io.errors()).toContain("readable by other users (mode 644)");
    expect(io.errors()).toContain("chmod 600");
  });

  it("exits 3 when the API refuses the token and 2 for an unusable config file", async () => {
    const api = createFakeApi();
    const io = session(api, {
      env: { [TOKEN_ENV]: `dlg_${"x".repeat(43)}`, [URL_ENV]: FAKE_ORIGIN },
    });
    expect(await runCli(["runs", "list"], io)).toBe(EXIT.auth);
    expect(io.errors()).toContain("(unauthorized)");
    const broken = createTestIo({ fetch: api.fetch });
    await broken.files.writePrivate(configPath(broken), "{nope");
    expect(await runCli(["runs", "list"], broken)).toBe(EXIT.auth);
    expect(broken.errors()).toContain("not a valid Delegate config file");
  });
});

describe("delegate run", () => {
  it("starts a Repo X-ray on a GitHub URL and prints where to follow it", async () => {
    const api = createFakeApi();
    const io = session(api);
    const code = await runCli(
      ["run", "repo-xray", "https://github.com/vercel/next.js", "--ref", "canary"],
      io,
    );
    expect(code).toBe(EXIT.ok);
    const [request] = api.requests;
    expect(request).toMatchObject({
      method: "POST",
      path: "/runs",
      body: {
        missionId: "repo-xray",
        input: { url: "https://github.com/vercel/next.js", ref: "canary" },
      },
    });
    expect(request?.headers["user-agent"]).toMatch(/^delegate-cli\//);
    const [run] = [...api.runs.values()];
    expect(io.text()).toBe(
      `Started repo-xray run ${run?.id ?? ""}\nOpen:   ${FAKE_ORIGIN}/runs/${run?.id ?? ""}\nFollow: delegate runs events ${run?.id ?? ""} --follow\n`,
    );
  });

  it("maps the argument and flags of every mission", async () => {
    const cases: [string[], unknown][] = [
      [
        ["company-xray", "acme.example", "--focus", "pricing"],
        { missionId: "company-xray", input: { url: "acme.example", focus: "pricing" } },
      ],
      [
        ["automation-audit", "acme.example", "--department", "Support"],
        { missionId: "automation-audit", input: { url: "acme.example", department: "Support" } },
      ],
      [
        [
          "build-agent",
          "acme.example",
          "--goal",
          "Answer support questions",
          "--name",
          "Helper",
          "--parent-run",
          "0d2f3c1e-3c5e-4d3c-9d55-6f1c3a529b10",
        ],
        {
          missionId: "build-agent",
          input: { url: "acme.example", goal: "Answer support questions", name: "Helper" },
          parentRunId: "0d2f3c1e-3c5e-4d3c-9d55-6f1c3a529b10",
        },
      ],
      [
        ["custom-goal", "Summarise the pricing page", "--site", "acme.example"],
        {
          missionId: "custom-goal",
          input: { goal: "Summarise the pricing page", url: "acme.example" },
        },
      ],
      [
        ["autopilot", "Audit acme.example and build the best assistant"],
        {
          missionId: "autopilot",
          input: { goal: "Audit acme.example and build the best assistant" },
        },
      ],
    ];
    for (const [argv, body] of cases) {
      const api = createFakeApi();
      expect(await runCli(["run", ...argv], session(api)), argv.join(" ")).toBe(EXIT.ok);
      expect(api.requests[0]?.body).toEqual(body);
    }
  });

  it("prints the run as JSON with --json and forwards --idempotency-key", async () => {
    const api = createFakeApi();
    const argv = [
      "run",
      "repo-xray",
      "https://github.com/a/b",
      "--json",
      "--idempotency-key",
      "deploy-42",
    ];
    const first = session(api);
    expect(await runCli(argv, first)).toBe(EXIT.ok);
    const second = session(api);
    expect(await runCli(argv, second)).toBe(EXIT.ok);
    expect(
      api.requests.map((request) => request.headers[IDEMPOTENCY_KEY_HEADER.toLowerCase()]),
    ).toEqual(["deploy-42", "deploy-42"]);
    const run = JSON.parse(first.text()) as Run;
    expect(run.mission).toBe("repo-xray");
    expect((JSON.parse(second.text()) as Run).id).toBe(run.id);
    expect(api.runs.size).toBe(1);
  });

  it("explains a refused request and exits 5; 6 when rate limited", async () => {
    const api = createFakeApi();
    const io = session(api);
    expect(await runCli(["run", "build-agent", "acme.example"], io)).toBe(EXIT.refused);
    expect(io.errors()).toContain("input.goal: build-agent needs goal");
    api.failNext.push({
      status: 429,
      code: "rate_limited",
      message: "Demo runs are limited per hour.",
      headers: { "retry-after": "1800" },
    });
    const limited = session(api);
    expect(await runCli(["run", "repo-xray", "https://github.com/a/b"], limited)).toBe(
      EXIT.rateLimited,
    );
    expect(limited.errors()).toContain("(rate_limited)");
    expect(limited.errors()).toContain("Try again in 30m 00s.");
    expect(limited.errors()).toContain("request id: req_test");
  });

  it("writes errors as JSON on stderr with --json", async () => {
    const api = createFakeApi();
    const io = session(api);
    expect(
      await runCli(["runs", "get", "0d2f3c1e-3c5e-4d3c-9d55-6f1c3a529b10", "--json"], io),
    ).toBe(EXIT.notFound);
    expect(io.text()).toBe("");
    expect(JSON.parse(io.errors())).toEqual({
      error: {
        code: "not_found",
        message: "No run with that id is visible to this token.",
        exitCode: 4,
        requestId: "req_test",
      },
    });
  });

  it("exits 7 when Delegate cannot be reached or fails", async () => {
    const api = createFakeApi();
    api.offline = true;
    const io = session(api);
    expect(await runCli(["runs", "list"], io)).toBe(EXIT.unavailable);
    expect(io.errors()).toContain(`Could not reach Delegate at ${FAKE_ORIGIN}`);
    api.offline = false;
    api.failNext.push(
      { status: 500, code: "internal", message: "The request failed on the server." },
      { status: 500, code: "internal", message: "The request failed on the server." },
      { status: 500, code: "internal", message: "The request failed on the server." },
    );
    const failing = session(api);
    expect(await runCli(["runs", "list"], failing)).toBe(EXIT.unavailable);
  });
});

describe("delegate run --watch", () => {
  it("streams the plan, steps, approvals and the deliverable, then exits 0", async () => {
    const api = createFakeApi();
    api.onStream = (runId, stream) => {
      const run = api.runs.get(runId);
      if (run === undefined) throw new Error("no run");
      playRepoXray(api, run, "completed");
      for (const event of api.events.get(runId) ?? []) stream.push(event);
      stream.end();
    };
    const io = session(api);
    const code = await runCli(
      ["run", "repo-xray", "https://github.com/vercel/next.js", "--watch"],
      io,
    );
    expect(code).toBe(EXIT.ok);
    const [run] = [...api.runs.values()];
    const url = `${FAKE_ORIGIN}/runs/${run?.id ?? ""}`;
    const text = io.text();
    expect(text).toContain(
      `Started repo-xray run ${run?.id ?? ""} on https://github.com/vercel/next.js`,
    );
    expect(text).toContain(`12:00:00  run      started · ${url}`);
    expect(text).toContain("12:00:01  plan     version 1, 2 steps");
    expect(text).toContain("            1. map: Map the architecture");
    expect(text).toContain("            2. risks: Find risk hotspots");
    expect(text).toContain("12:00:02  plan     approved by guest");
    expect(text).toContain("12:00:03  step     map started");
    expect(text).toContain("12:00:05  ok       map: 12 packages, 3 entry points");
    expect(text).toContain(
      "12:00:06  approve  needs a decision: tickets/update_record: close 14 tickets",
    );
    expect(text).toContain(`            decide in the web app: ${url}`);
    expect(text).toContain("12:00:07  artifact Architecture map (repo-xray)");
    expect(text).toContain("12:00:08  done     completed");
    expect(text).toMatch(/Run completed in \d+s · 15,400 tokens, 41 tool calls/);
    expect(text).toContain("Deliverable: Architecture map (repo-xray)");
    expect(text).toContain(`  delegate artifacts get ${run?.id ?? ""} repo-map`);
    expect(text).toContain("Mapped 12 packages.\nThree risk hotspots found.");
    expect(text.trimEnd().endsWith(`Open: ${url}`)).toBe(true);
    expect(text).not.toContain("repo_read");

    const verbose = session(api);
    await runCli(["runs", "events", run?.id ?? "", "--follow", "--verbose"], verbose);
    expect(verbose.text()).toContain("12:00:04  tool     repo_read README.md");
  });

  it("exits 10 when the run fails and 11 when it is cancelled", async () => {
    for (const [outcome, code, text] of [
      ["failed", EXIT.runFailed, "Run failed"],
      ["cancelled", EXIT.runCancelled, "Run cancelled"],
    ] as const) {
      const api = createFakeApi();
      api.onStream = (runId, stream) => {
        const run = api.runs.get(runId);
        if (run === undefined) throw new Error("no run");
        playRepoXray(api, run, outcome);
        for (const event of api.events.get(runId) ?? []) stream.push(event);
        stream.end();
      };
      const io = session(api);
      expect(await runCli(["run", "repo-xray", "https://github.com/a/b", "-w"], io)).toBe(code);
      expect(io.text()).toContain(text);
    }
  });

  it("emits one JSON object per line with --json and ends with the run", async () => {
    const api = createFakeApi();
    api.onStream = (runId, stream) => {
      const run = api.runs.get(runId);
      if (run === undefined) throw new Error("no run");
      playRepoXray(api, run, "completed");
      for (const event of api.events.get(runId) ?? []) stream.push(event);
      stream.end();
    };
    const io = session(api);
    expect(
      await runCli(["run", "repo-xray", "https://github.com/a/b", "--watch", "--json"], io),
    ).toBe(EXIT.ok);
    const lines = io
      .text()
      .trimEnd()
      .split("\n")
      .map((text) => JSON.parse(text) as { event?: { type: string; seq: number }; run?: Run });
    expect(lines.slice(0, -1).map((entry) => entry.event?.seq)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    expect(lines.at(-1)?.run).toMatchObject({ status: "completed", terminal: true });
  });

  it("says how to decide a plan that waits, with the web URL", async () => {
    const api = createFakeApi();
    let live: { push: (event: ReturnType<FakeApi["emit"]>) => void; end: () => void } | null = null;
    api.onStream = (runId, stream) => {
      live = stream;
      stream.push(api.emit(runId, "run.created", {}));
      stream.push(
        api.emit(runId, "plan.proposed", {
          version: 1,
          steps: [{ id: "map", objective: "Map the architecture" }],
        }),
      );
      api.setRun(runId, {
        status: "awaiting_plan_approval",
        pendingPlan: [{ id: "map", objective: "Map the architecture", status: "pending" }],
      });
    };
    const io = session(api);
    const finished = runCli(["run", "repo-xray", "https://github.com/a/b", "--watch"], io);
    await expect
      .poll(() => io.text(), { timeout: 5_000 })
      .toContain("approve: delegate approve-plan");
    const [run] = [...api.runs.values()];
    const id = run?.id ?? "";
    expect(io.text()).toContain("waiting for the plan to be approved");
    expect(io.text()).toContain(`approve: delegate approve-plan ${id}`);
    expect(io.text()).toContain(`reject:  delegate reject-plan ${id} --reason`);
    expect(io.text()).toContain(`or edit and decide in the web app: ${FAKE_ORIGIN}/runs/${id}`);

    const approver = session(api);
    expect(await runCli(["approve-plan", id], approver)).toBe(EXIT.ok);
    expect(approver.text()).toContain(`Plan approved for run ${id}.`);
    const stream = live as {
      push: (event: ReturnType<FakeApi["emit"]>) => void;
      end: () => void;
    } | null;
    if (stream === null) throw new Error("the stream never opened");
    stream.push(api.emit(id, "plan.approved", { version: 1 }));
    stream.push(api.emit(id, "run.completed", { summary: "Done." }));
    api.setRun(id, { status: "completed", terminal: true, summary: "Done." });
    stream.end();
    expect(await finished).toBe(EXIT.ok);
    expect(io.text().match(/approve: delegate approve-plan/g)).toHaveLength(1);
  });

  it("stops after --timeout with exit 12 and says the run keeps going", async () => {
    const api = createFakeApi();
    api.onStream = (runId, stream) => {
      stream.push(api.emit(runId, "run.created", {}));
    };
    const io = session(api);
    const code = await runCli(
      ["run", "repo-xray", "https://github.com/a/b", "--watch", "--timeout", "1"],
      io,
    );
    expect(code).toBe(EXIT.timedOut);
    const [run] = [...api.runs.values()];
    expect(io.errors()).toContain("the run is still going");
    expect(io.errors()).toContain(`delegate runs events ${run?.id ?? ""} --follow`);
  });

  it("exits 130 on Ctrl-C without cancelling the run", async () => {
    const api = createFakeApi();
    api.onStream = (runId, stream) => {
      stream.push(api.emit(runId, "run.created", {}));
    };
    const io = session(api);
    const finished = runCli(["run", "repo-xray", "https://github.com/a/b", "--watch"], io);
    await expect.poll(() => io.text()).toContain("started ·");
    io.interrupt();
    expect(await finished).toBe(EXIT.interrupted);
    expect(io.errors()).toContain("the run keeps going");
    expect(api.requests.some((request) => request.path.endsWith("/cancel"))).toBe(false);
  });

  it("strips terminal control sequences from run text", async () => {
    const api = createFakeApi();
    const hostile = `${ESC}[2J${ESC}]0;owned\u0007 done\r\nrm -rf ~ ‮`;
    api.onStream = (runId, stream) => {
      stream.push(
        api.emit(runId, "plan.proposed", {
          version: 1,
          steps: [{ id: "map", objective: hostile }],
        }),
      );
      stream.push(
        api.emit(runId, "step.completed", { outcome: "succeeded", summary: hostile }, "map"),
      );
      stream.push(api.emit(runId, "run.completed", { summary: hostile }));
      api.setRun(runId, { status: "completed", terminal: true, summary: hostile });
      stream.end();
    };
    const io = session(api);
    expect(await runCli(["run", "repo-xray", "https://github.com/a/b", "--watch"], io)).toBe(
      EXIT.ok,
    );
    const text = io.text();
    expect(text).not.toContain(ESC);
    expect(text).not.toContain("\u0007");
    expect(text).not.toContain("\r");
    expect(text).not.toContain("‮");
    expect(text).toContain("[2J ]0;owned done");
  });
});

describe("delegate runs, plans and artifacts", () => {
  it("lists runs as a table, pages with --cursor and filters by status", async () => {
    const api = createFakeApi();
    const first = api.addRun({ status: "completed", terminal: true });
    api.addRun({ mission: "company-xray", target: "acme.example" });
    api.addRun({ status: "failed", terminal: true });
    const io = session(api);
    expect(await runCli(["runs", "list", "--limit", "2"], io)).toBe(EXIT.ok);
    const lines = io.text().split("\n");
    expect(lines[0]).toMatch(/^RUN\s+STATUS\s+MISSION\s+CREATED \(UTC\)\s+TARGET$/);
    expect(lines[1]).toContain(`${first.id}  completed  repo-xray`);
    expect(io.text()).toContain("More: delegate runs list --cursor 2");
    const next = session(api);
    await runCli(["runs", "list", "--cursor", "2", "--status", "failed", "--json"], next);
    expect(api.requests.at(-1)?.query).toEqual({ limit: "20", cursor: "2", status: "failed" });
    expect(JSON.parse(next.text())).toHaveProperty("nextCursor", null);
    const empty = session(createFakeApi());
    await runCli(["runs", "list"], empty);
    expect(empty.text()).toBe("No runs.\n");
  });

  it("shows one run with its plan, approvals, steps and artifacts", async () => {
    const api = createFakeApi();
    const run = api.addRun({
      status: "awaiting_plan_approval",
      pendingPlan: [{ id: "map", objective: "Map the architecture", status: "pending" }],
      pendingApprovals: [{ approvalId: "a1", summary: "Open a pull request on acme/site" }],
      steps: [
        { id: "clone", objective: "Clone", status: "succeeded", summary: "Cloned 412 files" },
      ],
      artifacts: [
        { artifactId: "repo-map", kind: "repo-xray", title: "Architecture map", version: 2 },
      ],
    });
    const io = session(api);
    expect(await runCli(["runs", "get", run.id], io)).toBe(EXIT.ok);
    const text = io.text();
    expect(text).toContain(`Run      ${run.id}`);
    expect(text).toContain("Status   awaiting_plan_approval");
    expect(text).toContain("Plan waiting for approval:");
    expect(text).toContain(`approve: delegate approve-plan ${run.id}`);
    expect(text).toContain("Waiting for a decision in the web app:");
    expect(text).toContain(`decide at ${FAKE_ORIGIN}/runs/${run.id}`);
    expect(text).toContain("ok       clone: Cloned 412 files");
    expect(text).toContain("repo-map  Architecture map (repo-xray, v2)");
    const json = session(api);
    await runCli(["runs", "get", run.id, "--json"], json);
    expect((JSON.parse(json.text()) as Run).id).toBe(run.id);
  });

  it("pages through stored events without --follow", async () => {
    const api = createFakeApi();
    const run = api.addRun();
    playRepoXray(api, run, "completed");
    const io = session(api);
    expect(await runCli(["runs", "events", run.id, "--after", "6", "--json"], io)).toBe(EXIT.ok);
    const seqs = io
      .text()
      .trimEnd()
      .split("\n")
      .map((text) => (JSON.parse(text) as { event: { seq: number } }).event.seq);
    expect(seqs).toEqual([7, 8, 9]);
    expect(api.requests.every((request) => request.headers.accept === "application/json")).toBe(
      true,
    );
  });

  it("cancels a run, and exits 5 when it already finished", async () => {
    const api = createFakeApi();
    const run = api.addRun();
    const io = session(api);
    expect(await runCli(["runs", "cancel", run.id], io)).toBe(EXIT.ok);
    expect(io.text()).toBe(`Cancelled run ${run.id}.\n`);
    const again = session(api);
    expect(await runCli(["runs", "cancel", run.id], again)).toBe(EXIT.refused);
    expect(again.errors()).toContain("(run_finished)");
  });

  it("approves and rejects plans, with a reason", async () => {
    const api = createFakeApi();
    const plan = [{ id: "map", objective: "Map", status: "pending" as const }];
    const one = api.addRun({ status: "awaiting_plan_approval", pendingPlan: plan });
    const two = api.addRun({ status: "awaiting_plan_approval", pendingPlan: plan });
    const approve = session(api);
    expect(await runCli(["approve-plan", one.id, "--json"], approve)).toBe(EXIT.ok);
    expect(JSON.parse(approve.text())).toEqual({ runId: one.id, decision: "approved" });
    const reject = session(api);
    expect(await runCli(["reject-plan", two.id, "--reason", "Too broad"], reject)).toBe(EXIT.ok);
    expect(reject.text()).toBe(`Plan rejected for run ${two.id}.\n`);
    expect(api.requests.at(-1)).toMatchObject({
      path: `/runs/${two.id}/plan/reject`,
      body: { reason: "Too broad" },
    });
    const late = session(api);
    expect(await runCli(["approve-plan", one.id], late)).toBe(EXIT.refused);
    expect(late.errors()).toContain("(no_pending_plan)");
  });

  it("lists artifacts and prints or saves one", async () => {
    const api = createFakeApi();
    const run = api.addRun({
      artifacts: [
        { artifactId: "brief", kind: "company-xray-brief", title: "Acme brief", version: 3 },
      ],
    });
    api.artifacts.set("brief", {
      artifactId: "brief",
      kind: "company-xray-brief",
      title: "Acme brief",
      version: 3,
      content: { headline: "Acme sells anvils" },
    });
    api.artifacts.set("notes", {
      artifactId: "notes",
      kind: "markdown",
      title: "Notes",
      version: 1,
      content: "# Notes\n",
    });
    const list = session(api);
    expect(await runCli(["artifacts", "list", run.id], list)).toBe(EXIT.ok);
    expect(list.text()).toBe("brief  Acme brief (company-xray-brief, v3)\n");
    const get = session(api);
    expect(await runCli(["artifacts", "get", run.id, "brief"], get)).toBe(EXIT.ok);
    expect(JSON.parse(get.text())).toEqual({ headline: "Acme sells anvils" });
    const text = session(api);
    await runCli(["artifacts", "get", run.id, "notes"], text);
    expect(text.text()).toBe("# Notes\n");
    const saved = session(api);
    expect(
      await runCli(["artifacts", "get", run.id, "brief", "--json", "-o", "/tmp/brief.json"], saved),
    ).toBe(EXIT.ok);
    expect(saved.text()).toBe("Wrote Acme brief (company-xray-brief) to /tmp/brief.json\n");
    const written = await saved.files.read("/tmp/brief.json");
    expect(JSON.parse(written ?? "null")).toMatchObject({ artifactId: "brief", version: 3 });
    const missing = session(api);
    expect(await runCli(["artifacts", "get", run.id, "nope"], missing)).toBe(EXIT.notFound);
  });
});
