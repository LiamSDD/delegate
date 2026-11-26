import {
  type Artifact,
  CreateRunRequestSchema,
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  type Run,
  type RunEvent,
  RunSchema,
} from "@delegate/sdk";

import type { CliFiles, CliIo } from "./io";

export const FAKE_ORIGIN = "https://delegate.example";
export const FAKE_TOKEN = `dlg_${"t".repeat(43)}`;

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
}

interface EventStream {
  push(event: RunEvent): void;
  end(): void;
}

export interface FakeApi {
  fetch: typeof fetch;
  requests: RecordedRequest[];
  runs: Map<string, Run>;
  events: Map<string, RunEvent[]>;
  artifacts: Map<string, Artifact>;
  token: string;
  failNext: { status: number; code: string; message: string; headers?: Record<string, string> }[];
  offline: boolean;
  onStream: ((runId: string, stream: EventStream) => void) | null;
  addRun(overrides?: Partial<Run>): Run;
  setRun(runId: string, changes: Partial<Run>): Run;
  emit(runId: string, type: string, payload: Record<string, unknown>, stepId?: string): RunEvent;
}

function envelope(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
  issues?: string[],
): Response {
  const requestId = "req_test";
  return Response.json(
    { error: { code, message, requestId, ...(issues === undefined ? {} : { issues }) } },
    { status, headers: { [REQUEST_ID_HEADER]: requestId, ...headers } },
  );
}

function frame(event: RunEvent): string {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

let counter = 0;

function nextId(): string {
  counter += 1;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
}

export function createFakeApi(): FakeApi {
  const encoder = new TextEncoder();
  const keys = new Map<string, string>();
  const api: FakeApi = {
    requests: [],
    runs: new Map(),
    events: new Map(),
    artifacts: new Map(),
    token: FAKE_TOKEN,
    failNext: [],
    offline: false,
    onStream: null,
    addRun(overrides = {}) {
      const id = overrides.id ?? nextId();
      const run = RunSchema.parse({
        id,
        mission: "repo-xray",
        status: "planning",
        terminal: false,
        createdAt: "2026-11-25T12:00:00.000Z",
        finishedAt: null,
        totals: { inputTokens: 0, outputTokens: 0, costMicroUsd: 0, toolCalls: 0 },
        pendingPlan: null,
        pendingApprovals: [],
        steps: [],
        artifacts: [],
        deliverable: null,
        summary: null,
        error: null,
        target: "vercel/next.js",
        execution: "live",
        startedAt: null,
        webUrl: `${FAKE_ORIGIN}/runs/${id}`,
        ...overrides,
      });
      api.runs.set(id, run);
      api.events.set(id, api.events.get(id) ?? []);
      return run;
    },
    setRun(runId, changes) {
      const current = api.runs.get(runId);
      if (current === undefined) throw new Error(`no run ${runId}`);
      const next = RunSchema.parse({ ...current, ...changes });
      api.runs.set(runId, next);
      return next;
    },
    emit(runId, type, payload, stepId) {
      const log = api.events.get(runId) ?? [];
      const event: RunEvent = {
        runId,
        seq: log.length + 1,
        at: new Date(Date.UTC(2026, 10, 25, 12, 0, log.length)).toISOString(),
        type,
        payload,
        ...(stepId === undefined ? {} : { stepId }),
      };
      log.push(event);
      api.events.set(runId, log);
      return event;
    },
    fetch: async (input, init) => {
      if (api.offline) throw new TypeError("fetch failed");
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      const method = (init?.method ?? "GET").toUpperCase();
      const text = typeof init?.body === "string" ? init.body : "";
      const body: unknown = text === "" ? undefined : JSON.parse(text);
      const path = url.pathname.replace(/^\/api\/v1/, "");
      api.requests.push({
        method,
        path,
        query: Object.fromEntries(url.searchParams.entries()),
        headers,
        body,
      });
      await Promise.resolve();
      if (headers.authorization !== `Bearer ${api.token}`)
        return envelope(401, "unauthorized", "The API token is missing, invalid or revoked.");
      const failure = api.failNext.shift();
      if (failure !== undefined)
        return envelope(failure.status, failure.code, failure.message, failure.headers);
      const route = `${method} ${path}`;
      if (route === "POST /runs") {
        const parsed = CreateRunRequestSchema.safeParse(body);
        if (!parsed.success)
          return envelope(
            400,
            "invalid_request",
            "The body does not match the v1 contract.",
            {},
            parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
          );
        const key = headers[IDEMPOTENCY_KEY_HEADER.toLowerCase()] ?? "";
        const run =
          api.runs.get(keys.get(key) ?? "") ??
          api.addRun({
            mission: parsed.data.missionId,
            target: parsed.data.input.url ?? parsed.data.input.goal ?? null,
          });
        keys.set(key, run.id);
        return Response.json(run, { status: 201 });
      }
      if (route === "GET /runs") {
        const limit = Number(url.searchParams.get("limit") ?? "20");
        const all = [...api.runs.values()].filter(
          (run) =>
            url.searchParams.get("status") === null ||
            run.status === url.searchParams.get("status"),
        );
        const start = Number(url.searchParams.get("cursor") ?? "0");
        const page = all.slice(start, start + limit);
        return Response.json({
          data: page.map((run) => ({
            id: run.id,
            mission: run.mission,
            target: run.target,
            status: run.status,
            execution: run.execution,
            createdAt: run.createdAt,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
            webUrl: run.webUrl,
          })),
          nextCursor: start + limit < all.length ? String(start + limit) : null,
        });
      }
      const match = /^\/runs\/([^/]+)(\/.*)?$/.exec(path);
      const run = match === null ? undefined : api.runs.get(match[1] ?? "");
      if (match === null || run === undefined)
        return envelope(404, "not_found", "No run with that id is visible to this token.");
      const rest = match[2] ?? "";
      if (method === "GET" && rest === "") return Response.json(run);
      if (method === "POST" && rest === "/cancel") {
        if (run.terminal) return envelope(409, "run_finished", "This run has already finished.");
        return Response.json(
          api.setRun(run.id, {
            status: "failed",
            terminal: true,
            pendingPlan: null,
            error: { code: "cancelled", message: "cancelled by user" },
          }),
        );
      }
      if (method === "POST" && (rest === "/plan/approve" || rest === "/plan/reject")) {
        if (run.pendingPlan === null)
          return envelope(409, "no_pending_plan", "This run has no plan waiting for a decision.");
        api.setRun(run.id, { pendingPlan: null, status: "running" });
        return Response.json({
          runId: run.id,
          decision: rest === "/plan/approve" ? "approved" : "rejected",
        });
      }
      if (method === "GET" && rest === "/events") {
        const after = Number(url.searchParams.get("after") ?? "0");
        const log = api.events.get(run.id) ?? [];
        if ((headers.accept ?? "").includes("text/event-stream")) {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              let closed = false;
              const close = () => {
                if (closed) return;
                closed = true;
                controller.close();
              };
              init?.signal?.addEventListener("abort", () => {
                if (closed) return;
                closed = true;
                controller.error(new DOMException("aborted", "AbortError"));
              });
              for (const event of log.filter((entry) => entry.seq > after))
                controller.enqueue(encoder.encode(frame(event)));
              const live: EventStream = {
                push(event) {
                  if (!closed) controller.enqueue(encoder.encode(frame(event)));
                },
                end() {
                  if (closed) return;
                  controller.enqueue(encoder.encode("event: stream.end\ndata: {}\n\n"));
                  close();
                },
              };
              if (api.onStream === null) live.end();
              else api.onStream(run.id, live);
            },
          });
          return new Response(stream, { headers: { "content-type": "text/event-stream" } });
        }
        const limit = Number(url.searchParams.get("limit") ?? "200");
        const pending = log.filter((entry) => entry.seq > after);
        const page = pending.slice(0, limit);
        return Response.json({
          data: page,
          nextAfter: page.at(-1)?.seq ?? after,
          hasMore: pending.length > limit,
          terminal: run.terminal,
        });
      }
      if (method === "GET" && rest === "/artifacts") return Response.json({ data: run.artifacts });
      const artifact = /^\/artifacts\/(.+)$/.exec(rest);
      if (method === "GET" && artifact !== null) {
        const found = api.artifacts.get(decodeURIComponent(artifact[1] ?? ""));
        return found === undefined
          ? envelope(404, "not_found", "No artifact with that id is visible to this token.")
          : Response.json(found);
      }
      return envelope(404, "not_found", "No v1 operation answers this request.");
    },
  };
  return api;
}

export interface MemoryFiles extends CliFiles {
  entries: Map<string, { content: string; mode: number }>;
}

export function memoryFiles(): MemoryFiles {
  const entries = new Map<string, { content: string; mode: number }>();
  return {
    entries,
    read: (file) => Promise.resolve(entries.get(file)?.content ?? null),
    mode: (file) => Promise.resolve(entries.get(file)?.mode ?? null),
    writePrivate(file, content) {
      entries.set(file, { content, mode: 0o600 });
      return Promise.resolve();
    },
    write(file, content) {
      entries.set(file, { content, mode: 0o644 });
      return Promise.resolve();
    },
    remove: (file) => Promise.resolve(entries.delete(file)),
  };
}

export interface TestIo extends CliIo {
  out: string[];
  err: string[];
  text(): string;
  errors(): string;
  interrupt(): void;
  prompts: string[];
}

export function createTestIo(overrides: Partial<CliIo> & { secret?: string; stdin?: string } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const prompts: string[] = [];
  const controller = new AbortController();
  const { secret, stdin, ...rest } = overrides;
  const io: TestIo = {
    out,
    err,
    prompts,
    text: () => out.join(""),
    errors: () => err.join(""),
    interrupt: () => {
      controller.abort(new DOMException("Interrupted", "AbortError"));
    },
    env: {},
    homeDir: "/home/tester",
    platform: "linux",
    stdout: (text) => {
      out.push(text);
    },
    stderr: (text) => {
      err.push(text);
    },
    stdinIsTty: false,
    stdoutIsTty: false,
    readSecret: (prompt) => {
      prompts.push(prompt);
      return Promise.resolve(secret ?? "");
    },
    readStdin: () => Promise.resolve(stdin ?? ""),
    fetch: () => Promise.reject(new TypeError("no network in tests")),
    files: memoryFiles(),
    signal: controller.signal,
    now: () => Date.now(),
    sleep: () => Promise.resolve(),
    ...rest,
  };
  return io;
}
