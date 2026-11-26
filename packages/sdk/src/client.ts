import { type z } from "zod";

import { LooseErrorEnvelopeSchema } from "./contract/errors";
import {
  type PlanDecision,
  PlanDecisionSchema,
  type RunListEntry,
  type StartAutopilotRequest,
  StartAutopilotRequestSchema,
  type StartRunRequest,
  StartRunRequestSchema,
} from "./contract/legacy";
import {
  OPERATIONS,
  type OperationId,
  type OperationResponse,
  type OperationSpec,
  operationPath,
} from "./contract/operations";
import {
  type Artifact,
  type ArtifactRef,
  type AssistantSummary,
  CANCELLED_ERROR_CODE,
  type ChatAnswer,
  type ChatRequest,
  type ChatStreamEvent,
  ChatStreamEventSchema,
  type CreateRunRequest,
  IDEMPOTENCY_KEY_HEADER,
  type ListAssistantsQuery,
  type ListRunEventsQuery,
  type ListRunsQuery,
  MISSION_IDS,
  MISSION_INPUT_RULES,
  type MissionId,
  type PlanDecisionResult,
  RATE_LIMIT_HEADERS,
  REQUEST_ID_HEADER,
  type Run,
  type RunEvent,
  type RunEventPage,
  RunEventSchema,
  type RunList,
  type RunStatus,
  type RunSummary,
  isTerminalEventType,
} from "./contract/schemas";
import {
  DelegateApiError,
  DelegateConnectionError,
  DelegateResponseError,
  DelegateTimeoutError,
} from "./errors";
import { parseSse } from "./sse";

export const SDK_USER_AGENT = "delegate-sdk/1.0" as const;
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_POLL_INTERVAL_MS = 2_000;
export const MAX_STREAM_RECONNECTS = 5;

const RETRY_BASE_MS = 500;
const RETRY_CEILING_MS = 8_000;
const RETRY_AFTER_CEILING_MS = 30_000;
const HEALTHY_STREAM_MS = 5_000;
const EVENT_STREAM = "text/event-stream";

export interface RateLimitState {
  limit: number;
  remaining: number;
  resetSeconds: number;
}

export interface DelegateClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  userAgent?: string;
  maxRetries?: number;
  timeoutMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

export interface RequestOptions {
  signal?: AbortSignal;
  idempotencyKey?: string;
}

export interface RunEventsOptions {
  after?: number;
  signal?: AbortSignal;
}

export type WaitUntil = "terminal" | "attention";

export interface WaitForRunOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  until?: WaitUntil;
  signal?: AbortSignal;
  onPoll?: (run: Run) => void;
}

export interface RunsApi {
  create(request: CreateRunRequest, options?: RequestOptions): Promise<Run>;
  get(runId: string, options?: RequestOptions): Promise<Run>;
  list(query?: ListRunsQuery, options?: RequestOptions): Promise<RunList>;
  iterate(
    query?: Omit<ListRunsQuery, "cursor">,
    options?: RequestOptions,
  ): AsyncGenerator<RunSummary>;
  cancel(runId: string, options?: RequestOptions): Promise<Run>;
  approvePlan(runId: string, options?: RequestOptions): Promise<PlanDecisionResult>;
  rejectPlan(runId: string, reason?: string, options?: RequestOptions): Promise<PlanDecisionResult>;
  events(runId: string, options?: RunEventsOptions): AsyncGenerator<RunEvent>;
  listEvents(
    runId: string,
    query?: ListRunEventsQuery,
    options?: RequestOptions,
  ): Promise<RunEventPage>;
  wait(runId: string, options?: WaitForRunOptions): Promise<Run>;
}

export interface ArtifactsApi {
  list(runId: string, options?: RequestOptions): Promise<ArtifactRef[]>;
  get(runId: string, artifactId: string, options?: RequestOptions): Promise<Artifact>;
}

export interface AssistantsApi {
  list(query?: ListAssistantsQuery, options?: RequestOptions): Promise<AssistantSummary[]>;
  chat(assistantId: string, request: ChatRequest, options?: RequestOptions): Promise<ChatAnswer>;
  chatStream(
    assistantId: string,
    request: ChatRequest,
    options?: Pick<RequestOptions, "signal">,
  ): AsyncGenerator<ChatStreamEvent>;
}

export interface DelegateClient {
  readonly baseUrl: string;
  readonly runs: RunsApi;
  readonly artifacts: ArtifactsApi;
  readonly assistants: AssistantsApi;
  waitForRun(runId: string, options?: WaitForRunOptions): Promise<Run>;
  openapi(options?: Pick<RequestOptions, "signal">): Promise<Record<string, unknown>>;
  rateLimit(): RateLimitState | null;
  runUrl(runId: string): string;
  startRun(request: StartRunRequest): Promise<{ runId: string; webUrl: string }>;
  startAutopilot(request: StartAutopilotRequest): Promise<{ runId: string; webUrl: string }>;
  getRun(runId: string): Promise<Run>;
  listRuns(limit?: number): Promise<RunListEntry[]>;
  decidePlan(runId: string, decision: PlanDecision): Promise<{ decision: string }>;
  getArtifact(runId: string, artifactId: string): Promise<Artifact>;
}

const WAITING_STATUSES: ReadonlySet<string> = new Set<RunStatus>([
  "awaiting_plan_approval",
  "awaiting_approval",
]);

export function runNeedsAttention(run: Run): boolean {
  return (
    WAITING_STATUSES.has(run.status) ||
    (run.children ?? []).some((child) => WAITING_STATUSES.has(child.status))
  );
}

export function isCancelled(run: Pick<Run, "status" | "error">): boolean {
  return run.status === "failed" && run.error?.code === CANCELLED_ERROR_CODE;
}

function normaliseBase(raw: string): string {
  const url = new URL(raw);
  const local =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
    throw new Error("The Delegate base URL must use https (http is allowed for localhost only).");
  return url.origin;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (isAborted(signal)) {
      reject(abortReason(signal));
      return;
    }
    const done = () => {
      signal?.removeEventListener("abort", aborted);
      resolve();
    };
    const timer = setTimeout(done, ms);
    function aborted() {
      clearTimeout(timer);
      reject(abortReason(signal));
    }
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function abortReason(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error
    ? reason
    : new DOMException("The operation was aborted.", "AbortError");
}

function retryAfterMs(value: string | null, now: number): number | null {
  if (value === null || value.trim() === "") return null;
  const trimmed = value.trim();
  if (/^\d{1,9}$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

function readRateLimit(headers: Headers): RateLimitState | null {
  const values = [
    headers.get(RATE_LIMIT_HEADERS.limit),
    headers.get(RATE_LIMIT_HEADERS.remaining),
    headers.get(RATE_LIMIT_HEADERS.reset),
  ].map((value) => (value !== null && /^\d{1,12}$/.test(value.trim()) ? Number(value) : null));
  const [limit, remaining, resetSeconds] = values;
  if (limit === null || limit === undefined) return null;
  if (remaining === null || remaining === undefined) return null;
  if (resetSeconds === null || resetSeconds === undefined) return null;
  return { limit, remaining, resetSeconds };
}

function checked<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new DelegateApiError(
    400,
    "invalid_request",
    "The request does not match the v1 contract.",
    {
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
      ),
    },
  );
}

interface CallInit {
  params?: Record<string, string>;
  query?: unknown;
  body?: unknown;
  idempotencyKey?: string | undefined;
  signal?: AbortSignal | undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function legacyRunInput(request: StartRunRequest): CreateRunRequest {
  if (!(MISSION_IDS as readonly string[]).includes(request.missionId))
    return { missionId: request.missionId as MissionId, input: request.input };
  const missionId = request.missionId as MissionId;
  const rule = MISSION_INPUT_RULES[missionId];
  const allowed = new Set<string>([...rule.required, ...rule.optional]);
  return {
    missionId,
    input: Object.fromEntries(Object.entries(request.input).filter(([key]) => allowed.has(key))),
  };
}

export function createDelegateClient(options: DelegateClientOptions): DelegateClient {
  const baseUrl = normaliseBase(options.baseUrl);
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const baseHeaders = {
    authorization: `Bearer ${options.token}`,
    "user-agent": options.userAgent ?? SDK_USER_AGENT,
  };
  let lastRateLimit: RateLimitState | null = null;

  async function apiError(response: Response): Promise<DelegateApiError> {
    const text = await response.text().catch(() => "");
    const parsed = LooseErrorEnvelopeSchema.safeParse(parseJson(text));
    const envelope = parsed.success ? parsed.data.error : null;
    return new DelegateApiError(
      response.status,
      envelope?.code ?? "http_error",
      envelope?.message ?? `Delegate answered HTTP ${response.status}`,
      {
        requestId: envelope?.requestId ?? response.headers.get(REQUEST_ID_HEADER),
        retryAfterMs: retryAfterMs(response.headers.get("retry-after"), now()),
        ...(envelope?.issues === undefined ? {} : { issues: envelope.issues }),
      },
    );
  }

  async function attempt(
    url: string,
    init: RequestInit,
    outer: AbortSignal | undefined,
    limitMs: number | null,
  ): Promise<Response> {
    const controller = new AbortController();
    const forward = () => {
      controller.abort(abortReason(outer));
    };
    if (isAborted(outer)) throw abortReason(outer);
    outer?.addEventListener("abort", forward, { once: true });
    const deadline = { passed: false };
    const timer =
      limitMs === null
        ? undefined
        : setTimeout(() => {
            deadline.passed = true;
            controller.abort();
          }, limitMs);
    try {
      return await doFetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (isAborted(outer)) throw abortReason(outer);
      throw new DelegateConnectionError(
        deadline.passed
          ? `Delegate did not answer within ${limitMs ?? 0} ms.`
          : `Could not reach Delegate at ${baseUrl}.`,
        { cause: error },
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      outer?.removeEventListener("abort", forward);
    }
  }

  async function send(
    spec: OperationSpec,
    init: CallInit,
    mode: "json" | "stream",
  ): Promise<Response> {
    const params = spec.params === undefined ? undefined : checked(spec.params, init.params);
    const query = spec.query === undefined ? undefined : checked(spec.query, init.query ?? {});
    const hasBody = spec.body !== undefined && (init.body !== undefined || spec.bodyRequired);
    const body = hasBody && spec.body !== undefined ? checked(spec.body, init.body) : undefined;
    const url = new URL(operationPath(spec, params as Record<string, string> | undefined), baseUrl);
    for (const [key, value] of Object.entries(query ?? {}))
      if (typeof value === "string" || typeof value === "number")
        url.searchParams.set(key, String(value));
    const idempotencyKey =
      spec.method === "POST" && spec.idempotencyKey && mode === "json"
        ? (init.idempotencyKey ?? crypto.randomUUID())
        : undefined;
    const request: RequestInit = {
      method: spec.method,
      headers: {
        ...baseHeaders,
        accept: mode === "stream" ? EVENT_STREAM : "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(idempotencyKey === undefined ? {} : { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
    };
    const retrySafe = mode === "json" && (spec.method === "GET" || idempotencyKey !== undefined);
    for (let tries = 0; ; tries += 1) {
      const last = !retrySafe || tries >= maxRetries;
      const backoff = Math.min(RETRY_CEILING_MS, RETRY_BASE_MS * 2 ** tries);
      let response: Response;
      try {
        response = await attempt(
          url.href,
          request,
          init.signal,
          mode === "stream" ? null : timeoutMs,
        );
      } catch (error) {
        if (last || !(error instanceof DelegateConnectionError)) throw error;
        await sleep(backoff, init.signal);
        continue;
      }
      lastRateLimit = readRateLimit(response.headers) ?? lastRateLimit;
      if (response.ok) return response;
      const failure = await apiError(response);
      const wait = failure.retryAfterMs ?? backoff;
      if (last || !failure.retryable || wait > RETRY_AFTER_CEILING_MS) throw failure;
      await sleep(wait, init.signal);
    }
  }

  async function call<Id extends OperationId>(
    id: Id,
    init: CallInit = {},
  ): Promise<OperationResponse<Id>> {
    const spec: OperationSpec = OPERATIONS[id];
    const response = await send(spec, init, "json");
    const requestId = response.headers.get(REQUEST_ID_HEADER);
    let json: unknown;
    try {
      json = JSON.parse(await response.text());
    } catch {
      throw new DelegateResponseError(id, ["the body is not JSON"], requestId);
    }
    const parsed = spec.response.safeParse(json);
    if (!parsed.success)
      throw new DelegateResponseError(
        id,
        parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
        requestId,
      );
    return parsed.data as OperationResponse<Id>;
  }

  function withOptions(
    options: RequestOptions | undefined,
  ): Pick<CallInit, "idempotencyKey" | "signal"> {
    return { idempotencyKey: options?.idempotencyKey, signal: options?.signal };
  }

  const runUrl = (runId: string) => `${baseUrl}/runs/${encodeURIComponent(runId)}`;

  async function* runEvents(
    runId: string,
    options: RunEventsOptions = {},
  ): AsyncGenerator<RunEvent> {
    let cursor = options.after ?? 0;
    let barren = 0;
    for (;;) {
      const opened = now();
      const response = await send(
        OPERATIONS.listRunEvents,
        { params: { runId }, query: { after: cursor }, signal: options.signal },
        "stream",
      );
      if (response.status === 204 || response.body === null) return;
      let finished = false;
      let progressed = false;
      try {
        for await (const message of parseSse(response.body, options.signal)) {
          if (message.event === "stream.end") {
            finished = true;
            break;
          }
          if (message.event === "stream.error") break;
          if (message.event.startsWith("stream.")) continue;
          const parsed = RunEventSchema.safeParse(parseJson(message.data));
          if (!parsed.success)
            throw new DelegateResponseError(
              "listRunEvents",
              ["an event in the stream does not match the v1 contract"],
              response.headers.get(REQUEST_ID_HEADER),
            );
          const event = parsed.data;
          if (event.seq <= cursor) continue;
          cursor = event.seq;
          progressed = true;
          yield event;
          if (isTerminalEventType(event.type)) {
            finished = true;
            break;
          }
        }
      } catch (error) {
        if (isAborted(options.signal)) throw abortReason(options.signal);
        if (error instanceof DelegateResponseError) throw error;
      }
      if (finished) return;
      if (isAborted(options.signal)) throw abortReason(options.signal);
      barren = progressed || now() - opened >= HEALTHY_STREAM_MS ? 0 : barren + 1;
      if (barren > MAX_STREAM_RECONNECTS)
        throw new DelegateConnectionError(
          `The event stream of run ${runId} closed ${barren} times in a row without an event.`,
        );
      await sleep(Math.min(RETRY_CEILING_MS, RETRY_BASE_MS * 2 ** barren), options.signal);
    }
  }

  async function waitForRun(runId: string, options: WaitForRunOptions = {}): Promise<Run> {
    const limit = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    const interval = Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    const until = options.until ?? "terminal";
    const deadline = now() + limit;
    for (;;) {
      const run = await call("getRun", { params: { runId }, signal: options.signal });
      options.onPoll?.(run);
      if (run.terminal || (until === "attention" && runNeedsAttention(run))) return run;
      if (now() + interval > deadline) throw new DelegateTimeoutError(runId, limit, run);
      await sleep(interval, options.signal);
    }
  }

  const runs: RunsApi = {
    create: (request, options) => call("createRun", { body: request, ...withOptions(options) }),
    get: (runId, options) => call("getRun", { params: { runId }, signal: options?.signal }),
    list: (query, options) => call("listRuns", { query: query ?? {}, signal: options?.signal }),
    async *iterate(query, options) {
      let cursor: string | undefined;
      for (;;) {
        const page = await call("listRuns", {
          query: { ...query, ...(cursor === undefined ? {} : { cursor }) },
          signal: options?.signal,
        });
        yield* page.data;
        if (page.nextCursor === null) return;
        cursor = page.nextCursor;
      }
    },
    cancel: (runId, options) => call("cancelRun", { params: { runId }, ...withOptions(options) }),
    approvePlan: (runId, options) =>
      call("approvePlan", { params: { runId }, body: {}, ...withOptions(options) }),
    rejectPlan: (runId, reason, options) =>
      call("rejectPlan", {
        params: { runId },
        body: reason === undefined ? {} : { reason },
        ...withOptions(options),
      }),
    events: runEvents,
    listEvents: (runId, query, options) =>
      call("listRunEvents", { params: { runId }, query: query ?? {}, signal: options?.signal }),
    wait: waitForRun,
  };

  const artifacts: ArtifactsApi = {
    list: async (runId, options) =>
      (await call("listArtifacts", { params: { runId }, signal: options?.signal })).data,
    get: (runId, artifactId, options) =>
      call("getArtifact", { params: { runId, artifactId }, signal: options?.signal }),
  };

  const assistants: AssistantsApi = {
    list: async (query, options) =>
      (await call("listAssistants", { query: query ?? {}, signal: options?.signal })).data,
    chat: (assistantId, request, options) =>
      call("chatWithAssistant", {
        params: { assistantId },
        body: request,
        ...withOptions(options),
      }),
    async *chatStream(assistantId, request, options) {
      const response = await send(
        OPERATIONS.chatWithAssistant,
        { params: { assistantId }, body: request, signal: options?.signal },
        "stream",
      );
      if (response.body === null) return;
      for await (const message of parseSse(response.body, options?.signal)) {
        const event = ChatStreamEventSchema.safeParse(parseJson(message.data));
        if (!event.success)
          throw new DelegateResponseError(
            "chatWithAssistant",
            ["a message in the stream does not match the v1 contract"],
            response.headers.get(REQUEST_ID_HEADER),
          );
        yield event.data;
        if (event.data.type === "done" || event.data.type === "error") return;
      }
      if (isAborted(options?.signal)) throw abortReason(options?.signal);
    },
  };

  return {
    baseUrl,
    runs,
    artifacts,
    assistants,
    waitForRun,
    openapi: (options) => call("getOpenApi", { signal: options?.signal }),
    rateLimit: () => lastRateLimit,
    runUrl,
    async startRun(request) {
      const run = await runs.create(legacyRunInput(checked(StartRunRequestSchema, request)));
      return { runId: run.id, webUrl: runUrl(run.id) };
    },
    async startAutopilot(request) {
      const input = checked(StartAutopilotRequestSchema, request);
      const run = await runs.create({ missionId: "autopilot", input });
      return { runId: run.id, webUrl: runUrl(run.id) };
    },
    getRun: (runId) => runs.get(runId),
    async listRuns(limit = 20) {
      const page = await runs.list({ limit: Math.max(1, Math.min(50, Math.floor(limit))) });
      return page.data;
    },
    async decidePlan(runId, decision) {
      const parsed = checked(PlanDecisionSchema, decision);
      const result =
        parsed.decision === "approved"
          ? await runs.approvePlan(runId)
          : await runs.rejectPlan(runId, parsed.reason);
      return { decision: result.decision };
    },
    getArtifact: (runId, artifactId) => artifacts.get(runId, artifactId),
  };
}
