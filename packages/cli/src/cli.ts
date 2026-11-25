import { parseArgs, type ParseArgsConfig } from "node:util";

import {
  type CreateRunRequest,
  createDelegateClient,
  type DelegateClient,
  DelegateApiError,
  DelegateConnectionError,
  DelegateResponseError,
  isCancelled,
  MISSION_IDS,
  MISSION_INPUT_RULES,
  type MissionId,
  type Run,
  RUN_STATUSES,
  type RunEvent,
  type RunInputField,
  type RunStatus,
} from "@delegate/sdk";

import {
  type Credentials,
  DEFAULT_BASE_URL,
  normaliseBaseUrl,
  readConfig,
  resolveCredentials,
  TOKEN_ENV,
  TOKEN_PATTERN,
  URL_ENV,
  writeConfig,
  configPath,
} from "./config";
import { CliError, EXIT, type ExitCode, usage } from "./exit-codes";
import type { CliIo } from "./io";
import {
  duration,
  plain,
  planDecisionHint,
  renderEvent,
  renderOutcome,
  renderRun,
  renderRunList,
} from "./render";

export const CLI_VERSION = "0.1.0";
export const CLI_USER_AGENT = `delegate-cli/${CLI_VERSION}`;
const PLAN_HINT_QUIET_MS = 1_500;
const TOKEN_PAGE_HINT = "Create one in the web app under Settings, Connections.";

const FLAG_FOR_FIELD: Record<RunInputField, string> = {
  url: "site",
  goal: "goal",
  focus: "focus",
  department: "department",
  name: "name",
  opportunityId: "opportunity",
  ref: "ref",
};

const missionLines = MISSION_IDS.map((id) => {
  const rule = MISSION_INPUT_RULES[id];
  const extras = [...rule.required, ...rule.optional].filter((field) => field !== rule.leads);
  const flags = extras.map((field) => `--${FLAG_FOR_FIELD[field]}`).join(" ");
  return `  ${id.padEnd(17)} <${rule.leads}>${flags === "" ? "" : `  ${flags}`}`;
});

export const HELP = `delegate ${CLI_VERSION}: start and follow Delegate runs from a terminal

Usage
  delegate login [--api-url <url>] [--token-stdin]
  delegate logout
  delegate run <mission> <input> [--watch] [--json] [mission options]
  delegate runs list [--status <status>] [--limit <n>] [--cursor <cursor>] [--json]
  delegate runs get <run-id> [--json]
  delegate runs events <run-id> [--after <seq>] [--follow] [--json]
  delegate runs cancel <run-id> [--json]
  delegate approve-plan <run-id> [--json]
  delegate reject-plan <run-id> [--reason <text>] [--json]
  delegate artifacts list <run-id> [--json]
  delegate artifacts get <run-id> <artifact-id> [--output <file>] [--json]
  delegate missions

Missions and their input
${missionLines.join("\n")}

Options
  --watch, -w            Stream the run until it finishes (run)
  --follow, -f           Keep streaming until the run finishes (runs events)
  --json                 Machine-readable output; with --watch or --follow, one JSON object per line
  --verbose              Also show tool calls and agent messages while streaming
  --timeout <seconds>    Stop watching after this long (exit 12); the run keeps going
  --idempotency-key <k>  Make "run" safe to retry: the same key returns the same run for 24 hours
  --api-url <url>        The Delegate deployment (default: the one you logged in to, or ${URL_ENV})
  --help, -h             This text
  --version              The CLI version

Authentication
  "delegate login" asks for an API token without echoing it and stores it in a file only you
  can read. ${TOKEN_ENV} overrides the stored token. ${TOKEN_PAGE_HINT}

Exit codes
  0 ok (with --watch: the run completed)   1 unexpected error    2 bad usage
  3 not authenticated or not allowed       4 not found           5 request refused
  6 rate limited                           7 Delegate unreachable or failing
  10 run failed   11 run cancelled   12 --timeout elapsed   130 interrupted
`;

const OPTIONS = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" },
  json: { type: "boolean" },
  watch: { type: "boolean", short: "w" },
  follow: { type: "boolean", short: "f" },
  verbose: { type: "boolean" },
  "api-url": { type: "string" },
  "token-stdin": { type: "boolean" },
  timeout: { type: "string" },
  "idempotency-key": { type: "string" },
  site: { type: "string" },
  goal: { type: "string" },
  focus: { type: "string" },
  department: { type: "string" },
  name: { type: "string" },
  opportunity: { type: "string" },
  ref: { type: "string" },
  "parent-run": { type: "string" },
  status: { type: "string" },
  limit: { type: "string" },
  cursor: { type: "string" },
  after: { type: "string" },
  reason: { type: "string" },
  output: { type: "string", short: "o" },
} as const satisfies ParseArgsConfig["options"];

type Flags = ReturnType<typeof parseArgs<{ options: typeof OPTIONS }>>["values"];

interface Invocation {
  positionals: string[];
  flags: Flags;
}

function parse(argv: readonly string[]): Invocation {
  try {
    const parsed = parseArgs({
      args: [...argv],
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
    return { positionals: parsed.positionals, flags: parsed.values };
  } catch (error) {
    throw usage(
      error instanceof Error
        ? (error.message.split("\n")[0] ?? "Bad arguments.")
        : "Bad arguments.",
      "Run `delegate --help` for the commands and options.",
    );
  }
}

function integer(value: string | undefined, name: string, min: number, max: number) {
  if (value === undefined) return undefined;
  if (!/^\d{1,9}$/.test(value) || Number(value) < min || Number(value) > max)
    throw usage(`--${name} must be a whole number from ${min} to ${max}.`);
  return Number(value);
}

function exactly(positionals: readonly string[], names: readonly string[], command: string) {
  if (positionals.length !== names.length)
    throw usage(
      `Usage: delegate ${command} ${names.map((name) => `<${name}>`).join(" ")}`.trim(),
      positionals.length > names.length ? "Quote an argument that contains spaces." : undefined,
    );
  return positionals;
}

function line(io: CliIo, text = ""): void {
  io.stdout(`${text}\n`);
}

function printJson(io: CliIo, value: unknown): void {
  io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

function printJsonLine(io: CliIo, value: unknown): void {
  io.stdout(`${JSON.stringify(value)}\n`);
}

interface Session {
  client: DelegateClient;
  credentials: Credentials;
}

function clientFor(io: CliIo, credentials: Pick<Credentials, "baseUrl" | "token">): DelegateClient {
  return createDelegateClient({
    baseUrl: credentials.baseUrl,
    token: credentials.token,
    fetch: (input, init) => io.fetch(input, init),
    userAgent: CLI_USER_AGENT,
    now: () => io.now(),
    ...(io.sleep === undefined ? {} : { sleep: io.sleep }),
  });
}

async function connect(io: CliIo, flags: Flags): Promise<Session> {
  const credentials = await resolveCredentials(io, flags["api-url"]);
  return { client: clientFor(io, credentials), credentials };
}

async function login(io: CliIo, { positionals, flags }: Invocation): Promise<ExitCode> {
  exactly(positionals, [], "login");
  const stored = await readConfig(io).catch(() => null);
  const envUrl = io.env[URL_ENV]?.trim();
  const baseUrl = normaliseBaseUrl(
    flags["api-url"] ??
      (envUrl === undefined || envUrl === "" ? undefined : envUrl) ??
      stored?.config?.baseUrl ??
      DEFAULT_BASE_URL,
  );
  let token: string;
  if (flags["token-stdin"] === true || !io.stdinIsTty) {
    token = (await io.readStdin()).trim();
  } else {
    io.stderr(`Logging in to ${baseUrl}. ${TOKEN_PAGE_HINT}\n`);
    token = (await io.readSecret("API token (input is hidden): ")).trim();
  }
  if (!TOKEN_PATTERN.test(token))
    throw new CliError(
      EXIT.auth,
      "That is not a Delegate API token (they start with dlg_). Nothing was stored.",
      TOKEN_PAGE_HINT,
    );
  try {
    await clientFor(io, { baseUrl, token }).runs.list({ limit: 1 }, { signal: io.signal });
  } catch (error) {
    if (error instanceof DelegateApiError && (error.status === 401 || error.status === 403))
      throw new CliError(
        EXIT.auth,
        `${baseUrl} did not accept the token. Nothing was stored.`,
        "Check that the token was copied whole and has not been revoked.",
      );
    throw error;
  }
  const file = await writeConfig(io, { baseUrl, token });
  line(io, `Logged in to ${baseUrl}.`);
  line(io, `The token is stored in ${file}, readable only by you (mode 600).`);
  if ((io.env[TOKEN_ENV] ?? "") !== "")
    io.stderr(`note: ${TOKEN_ENV} is set and overrides the stored token.\n`);
  return EXIT.ok;
}

async function logout(io: CliIo, { positionals }: Invocation): Promise<ExitCode> {
  exactly(positionals, [], "logout");
  const file = configPath(io);
  const removed = await io.files.remove(file);
  line(io, removed ? `Removed ${file}.` : "No stored token.");
  line(io, "To revoke the token itself, use Settings, Connections in the web app.");
  return EXIT.ok;
}

function missions(io: CliIo, { flags }: Invocation): ExitCode {
  if (flags.json === true) {
    printJson(
      io,
      MISSION_IDS.map((id) => ({ id, ...MISSION_INPUT_RULES[id] })),
    );
    return EXIT.ok;
  }
  for (const id of MISSION_IDS) {
    const rule = MISSION_INPUT_RULES[id];
    const extras = [...rule.required, ...rule.optional]
      .filter((field) => field !== rule.leads)
      .map(
        (field) =>
          `--${FLAG_FOR_FIELD[field]}${rule.required.includes(field) ? " (required)" : ""}`,
      );
    line(io, `${id.padEnd(17)} ${rule.title}`);
    line(
      io,
      `${" ".repeat(18)}delegate run ${id} <${rule.leads}>${extras.length === 0 ? "" : ` ${extras.join(" ")}`}`,
    );
  }
  return EXIT.ok;
}

function runRequest(mission: string, input: string, flags: Flags): CreateRunRequest {
  if (!(MISSION_IDS as readonly string[]).includes(mission))
    throw usage(
      `Unknown mission "${plain(mission, 60)}".`,
      `Missions: ${MISSION_IDS.join(", ")}. Run \`delegate missions\` for their input.`,
    );
  const missionId = mission as MissionId;
  const rule = MISSION_INPUT_RULES[missionId];
  const fields: Partial<Record<RunInputField, string>> = { [rule.leads]: input };
  for (const [field, flag] of Object.entries(FLAG_FOR_FIELD) as [RunInputField, string][]) {
    const value = flags[flag as keyof Flags];
    if (typeof value !== "string") continue;
    if (field === rule.leads)
      throw usage(`${missionId} takes its ${field} as the argument, not as --${flag}.`);
    fields[field] = value;
  }
  const parent = flags["parent-run"];
  return {
    missionId,
    input: fields,
    ...(parent === undefined ? {} : { parentRunId: parent }),
  };
}

interface WatchOptions {
  json: boolean;
  verbose: boolean;
  after: number;
  timeoutSeconds: number | undefined;
  startedAt: number | null;
}

async function watch(
  io: CliIo,
  client: DelegateClient,
  runId: string,
  options: WatchOptions,
): Promise<ExitCode> {
  const runUrl = client.runUrl(runId);
  const limit = new AbortController();
  const signal = AbortSignal.any([io.signal, limit.signal]);
  const timer =
    options.timeoutSeconds === undefined
      ? undefined
      : setTimeout(() => {
          limit.abort(new DOMException("Timed out", "TimeoutError"));
        }, options.timeoutSeconds * 1000);
  const show = (event: RunEvent) => {
    if (options.json) printJsonLine(io, { event });
    else
      for (const text of renderEvent(event, { runUrl, verbose: options.verbose })) line(io, text);
  };
  const iterator = client.runs.events(runId, { after: options.after, signal });
  let planUndecided = false;
  let hinted = false;
  const advance = () => {
    const step = iterator.next();
    step.catch(() => undefined);
    return step;
  };
  let next = advance();
  try {
    for (;;) {
      let quiet: ReturnType<typeof setTimeout> | undefined;
      const idle =
        planUndecided && !hinted && !options.json
          ? new Promise<"idle">((resolve) => {
              quiet = setTimeout(() => {
                resolve("idle");
              }, PLAN_HINT_QUIET_MS);
            })
          : null;
      const step = await (idle === null ? next : Promise.race([next, idle]));
      clearTimeout(quiet);
      if (step === "idle") {
        hinted = true;
        const current = await client.runs.get(runId, { signal });
        if (current.status === "awaiting_plan_approval")
          for (const text of [
            "            waiting for the plan to be approved",
            ...planDecisionHint(runId, runUrl),
          ])
            line(io, text);
        continue;
      }
      if (step.done === true) break;
      show(step.value);
      if (step.value.type === "plan.proposed" || step.value.type === "plan.revised") {
        planUndecided = true;
        hinted = false;
      } else if (step.value.type === "plan.approved" || step.value.type === "run.failed") {
        planUndecided = false;
      }
      next = advance();
    }
  } catch (error) {
    if (limit.signal.aborted && !io.signal.aborted) {
      io.stderr(
        `Stopped watching after ${duration((options.timeoutSeconds ?? 0) * 1000)}; the run is still going.\nFollow it again: delegate runs events ${runId} --follow\nOpen: ${runUrl}\n`,
      );
      return EXIT.timedOut;
    }
    if (io.signal.aborted)
      io.stderr(
        `\nStopped watching; the run keeps going.\nFollow it again: delegate runs events ${runId} --follow\nOpen: ${runUrl}\n`,
      );
    throw error;
  } finally {
    clearTimeout(timer);
    await iterator.return(undefined).catch(() => undefined);
  }
  const run = await client.runs.get(runId, { signal: io.signal });
  if (options.json) printJsonLine(io, { run });
  else
    for (const text of renderOutcome(
      run,
      options.startedAt === null ? null : io.now() - options.startedAt,
    ))
      line(io, text);
  return outcomeCode(run);
}

function outcomeCode(run: Run): ExitCode {
  if (run.status === "completed") return EXIT.ok;
  if (isCancelled(run)) return EXIT.runCancelled;
  return run.status === "failed" ? EXIT.runFailed : EXIT.ok;
}

async function run(io: CliIo, invocation: Invocation): Promise<ExitCode> {
  const { flags } = invocation;
  const [mission = "", input = ""] = exactly(invocation.positionals, ["mission", "input"], "run");
  const request = runRequest(mission, input, flags);
  const timeoutSeconds = integer(flags.timeout, "timeout", 1, 86_400);
  const { client } = await connect(io, flags);
  const startedAt = io.now();
  const created = await client.runs.create(request, {
    signal: io.signal,
    ...(flags["idempotency-key"] === undefined ? {} : { idempotencyKey: flags["idempotency-key"] }),
  });
  const json = flags.json === true;
  if (flags.watch !== true) {
    if (json) printJson(io, created);
    else {
      line(io, `Started ${created.mission} run ${created.id}`);
      line(io, `Open:   ${created.webUrl}`);
      line(io, `Follow: delegate runs events ${created.id} --follow`);
    }
    return EXIT.ok;
  }
  if (!json)
    line(
      io,
      `Started ${created.mission} run ${created.id}${created.target === null ? "" : ` on ${plain(created.target)}`}`,
    );
  return watch(io, client, created.id, {
    json,
    verbose: flags.verbose === true,
    after: 0,
    timeoutSeconds,
    startedAt,
  });
}

async function runs(io: CliIo, invocation: Invocation): Promise<ExitCode> {
  const { flags } = invocation;
  const [action, ...rest] = invocation.positionals;
  const json = flags.json === true;
  if (action === "list") {
    exactly(rest, [], "runs list");
    const status = flags.status;
    if (status !== undefined && !(RUN_STATUSES as readonly string[]).includes(status))
      throw usage(`--status must be one of: ${RUN_STATUSES.join(", ")}.`);
    const limit = integer(flags.limit, "limit", 1, 100);
    const { client } = await connect(io, flags);
    const page = await client.runs.list(
      {
        ...(limit === undefined ? {} : { limit }),
        ...(status === undefined ? {} : { status: status as RunStatus }),
        ...(flags.cursor === undefined ? {} : { cursor: flags.cursor }),
      },
      { signal: io.signal },
    );
    if (json) printJson(io, page);
    else {
      for (const text of renderRunList(page.data)) line(io, text);
      if (page.nextCursor !== null)
        line(io, `\nMore: delegate runs list --cursor ${page.nextCursor}`);
    }
    return EXIT.ok;
  }
  if (action === "get") {
    const [runId = ""] = exactly(rest, ["run-id"], "runs get");
    const { client } = await connect(io, flags);
    const found = await client.runs.get(runId, { signal: io.signal });
    if (json) printJson(io, found);
    else for (const text of renderRun(found)) line(io, text);
    return EXIT.ok;
  }
  if (action === "cancel") {
    const [runId = ""] = exactly(rest, ["run-id"], "runs cancel");
    const { client } = await connect(io, flags);
    const cancelled = await client.runs.cancel(runId, { signal: io.signal });
    if (json) printJson(io, cancelled);
    else line(io, `Cancelled run ${cancelled.id}.`);
    return EXIT.ok;
  }
  if (action === "events") {
    const [runId = ""] = exactly(rest, ["run-id"], "runs events");
    const after = integer(flags.after, "after", 0, 999_999_999) ?? 0;
    const timeoutSeconds = integer(flags.timeout, "timeout", 1, 86_400);
    const { client } = await connect(io, flags);
    if (flags.follow === true)
      return watch(io, client, runId, {
        json,
        verbose: flags.verbose === true,
        after,
        timeoutSeconds,
        startedAt: null,
      });
    const runUrl = client.runUrl(runId);
    for (let cursor = after; ;) {
      const page = await client.runs.listEvents(runId, { after: cursor }, { signal: io.signal });
      for (const event of page.data) {
        if (json) printJsonLine(io, { event });
        else
          for (const text of renderEvent(event, { runUrl, verbose: flags.verbose === true }))
            line(io, text);
      }
      cursor = page.nextAfter;
      if (!page.hasMore) break;
    }
    return EXIT.ok;
  }
  throw usage(
    action === undefined
      ? "Usage: delegate runs <list|get|events|cancel>"
      : `Unknown command "runs ${plain(action, 40)}".`,
    "Run `delegate --help` for the commands.",
  );
}

async function decidePlan(
  io: CliIo,
  invocation: Invocation,
  decision: "approve" | "reject",
): Promise<ExitCode> {
  const { flags } = invocation;
  const [runId = ""] = exactly(invocation.positionals, ["run-id"], `${decision}-plan`);
  if (decision === "approve" && flags.reason !== undefined)
    throw usage("--reason is for reject-plan.");
  const { client } = await connect(io, flags);
  const result =
    decision === "approve"
      ? await client.runs.approvePlan(runId, { signal: io.signal })
      : await client.runs.rejectPlan(runId, flags.reason, { signal: io.signal });
  if (flags.json === true) printJson(io, result);
  else {
    line(io, `Plan ${result.decision} for run ${result.runId}.`);
    if (result.decision === "approved")
      line(io, `Follow: delegate runs events ${result.runId} --follow`);
  }
  return EXIT.ok;
}

async function artifacts(io: CliIo, invocation: Invocation): Promise<ExitCode> {
  const { flags } = invocation;
  const [action, ...rest] = invocation.positionals;
  const json = flags.json === true;
  if (action === "list") {
    const [runId = ""] = exactly(rest, ["run-id"], "artifacts list");
    const { client } = await connect(io, flags);
    const refs = await client.artifacts.list(runId, { signal: io.signal });
    if (json) printJson(io, { data: refs });
    else if (refs.length === 0) line(io, "No artifacts yet.");
    else
      for (const ref of refs)
        line(
          io,
          `${plain(ref.artifactId, 60)}  ${plain(ref.title)} (${plain(ref.kind, 40)}, v${ref.version})`,
        );
    return EXIT.ok;
  }
  if (action === "get") {
    const [runId = "", artifactId = ""] = exactly(rest, ["run-id", "artifact-id"], "artifacts get");
    const { client } = await connect(io, flags);
    const artifact = await client.artifacts.get(runId, artifactId, { signal: io.signal });
    const body = json
      ? JSON.stringify(artifact, null, 2)
      : typeof artifact.content === "string"
        ? artifact.content
        : JSON.stringify(artifact.content, null, 2);
    if (flags.output === undefined) {
      io.stdout(body.endsWith("\n") ? body : `${body}\n`);
      return EXIT.ok;
    }
    await io.files.write(flags.output, body.endsWith("\n") ? body : `${body}\n`);
    line(io, `Wrote ${plain(artifact.title)} (${plain(artifact.kind, 40)}) to ${flags.output}`);
    return EXIT.ok;
  }
  throw usage(
    action === undefined
      ? "Usage: delegate artifacts <list|get>"
      : `Unknown command "artifacts ${plain(action, 40)}".`,
    "Run `delegate --help` for the commands.",
  );
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

interface Failure {
  exitCode: ExitCode;
  message: string;
  hint?: string;
  code?: string;
  requestId?: string | null;
  issues?: readonly string[];
}

export function describeFailure(error: unknown, interrupted: boolean): Failure {
  if (error instanceof CliError)
    return {
      exitCode: error.exitCode,
      message: error.message,
      ...(error.hint === undefined ? {} : { hint: error.hint }),
    };
  if (error instanceof DelegateApiError) {
    const exitCode =
      error.status === 401 || error.status === 403
        ? EXIT.auth
        : error.status === 404
          ? EXIT.notFound
          : error.status === 429
            ? EXIT.rateLimited
            : error.status >= 500
              ? EXIT.unavailable
              : EXIT.refused;
    const retry =
      error.retryAfterMs === null ? undefined : `Try again in ${duration(error.retryAfterMs)}.`;
    const hint =
      error.status === 401
        ? "Run `delegate login` with a current token."
        : error.code === "no_pending_plan"
          ? "The plan may already be decided: delegate runs get <run-id>"
          : retry;
    return {
      exitCode,
      message: plain(error.message, 500),
      code: plain(error.code, 60),
      requestId: error.requestId,
      issues: error.issues.map((issue) => plain(issue, 300)),
      ...(hint === undefined ? {} : { hint }),
    };
  }
  if (interrupted || isAbort(error)) return { exitCode: EXIT.interrupted, message: "Interrupted." };
  if (error instanceof DelegateConnectionError)
    return {
      exitCode: EXIT.unavailable,
      message: error.message,
      hint: `Check the URL (--api-url or ${URL_ENV}) and your connection.`,
    };
  if (error instanceof DelegateResponseError)
    return {
      exitCode: EXIT.unavailable,
      message: plain(error.message, 500),
      requestId: error.requestId,
      hint: "The server and this CLI may be different versions.",
    };
  return {
    exitCode: EXIT.error,
    message: error instanceof Error ? plain(error.message, 500) : "Unexpected error.",
  };
}

function report(io: CliIo, failure: Failure, json: boolean): void {
  if (json) {
    io.stderr(
      `${JSON.stringify({
        error: {
          code: failure.code ?? "cli_error",
          message: failure.message,
          exitCode: failure.exitCode,
          ...(typeof failure.requestId === "string" ? { requestId: failure.requestId } : {}),
          ...(failure.issues === undefined || failure.issues.length === 0
            ? {}
            : { issues: failure.issues }),
        },
      })}\n`,
    );
    return;
  }
  const code = failure.code === undefined ? "" : ` (${failure.code})`;
  io.stderr(`delegate: ${failure.message}${code}\n`);
  for (const issue of failure.issues ?? []) io.stderr(`  - ${issue}\n`);
  if (failure.hint !== undefined) io.stderr(`${failure.hint}\n`);
  if (typeof failure.requestId === "string")
    io.stderr(`request id: ${plain(failure.requestId, 80)}\n`);
}

const COMMANDS: Record<
  string,
  (io: CliIo, invocation: Invocation) => Promise<ExitCode> | ExitCode
> = {
  login,
  logout,
  missions,
  run,
  runs,
  artifacts,
  "approve-plan": (io, invocation) => decidePlan(io, invocation, "approve"),
  "reject-plan": (io, invocation) => decidePlan(io, invocation, "reject"),
};

export async function runCli(argv: readonly string[], io: CliIo): Promise<ExitCode> {
  const wantsJson = argv.includes("--json");
  try {
    const { positionals, flags } = parse(argv);
    if (flags.version === true) {
      line(io, CLI_VERSION);
      return EXIT.ok;
    }
    const [name, ...rest] = positionals;
    if (flags.help === true || name === undefined || name === "help") {
      io.stdout(HELP);
      return name === undefined && flags.help !== true ? EXIT.usage : EXIT.ok;
    }
    const command = COMMANDS[name];
    if (command === undefined)
      throw usage(
        `Unknown command "${plain(name, 40)}".`,
        "Run `delegate --help` for the commands.",
      );
    return await command(io, { positionals: rest, flags });
  } catch (error) {
    const failure = describeFailure(error, io.signal.aborted);
    if (failure.exitCode !== EXIT.interrupted || !io.signal.aborted) report(io, failure, wantsJson);
    return failure.exitCode;
  }
}
