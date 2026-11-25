import type { FindInstallation } from "@delegate/runtime/server";
import { type ForkPlan, MAX_FORK_OBJECTIVE_CHARS, parseGithubRepoUrl } from "@delegate/runtime";
import { z } from "zod";

import { RUNNABLE_MISSION_IDS } from "@/lib/m2-contract";
import { COMPANY_URL_REJECTION_MESSAGES, normaliseCompanyUrl } from "@/lib/runs/company-url";
import { validatePlanEdit } from "@/lib/runs/plan";
import { runTarget } from "@/lib/runs/target";
import { AUTO_APPROVE_COOKIE } from "@/lib/runs/preferences";

import { authenticateBearer, hasBearer } from "./api-tokens";
import type { AppDatabase } from "./db";
import { reviveOrSweep } from "./durable";
import { executeRun } from "./execute-run";
import { createForkRecord, planRunFork } from "./fork";
import { createDbLease } from "./leases";
import type { MissionConnections, MissionRunner } from "./mission-runner";
import { pendingPlanApproval, PlanDecisionError, recordPlanDecision } from "./plan-approval";
import type { RunRegistry } from "./run-registry";
import {
  appendEvent,
  artifactContent,
  createRunRecord,
  type Execution,
  getRunRecord,
  isTerminalEventType,
  listRuns,
  missionInputOf,
  readAllEvents,
  readEvents,
  RunAlreadyTerminalError,
  type RunRecord,
} from "./runs";
import {
  type GuestSession,
  type RateLimiter,
  readGuest,
  resolveGuest,
  SESSION_COOKIE,
  sessionCookieOptions,
  signSession,
} from "./session";
import { buildRunView } from "./run-view-api";
import { createRunEventStream, parseResumeSeq, type RunStreamOptions, SSE_HEADERS } from "./sse";
import { readAutomation } from "./workspace-settings";

export interface ApiDeps {
  app: () => Promise<AppDatabase>;
  secret: () => string;
  guestLimiter: RateLimiter;
  ipLimiter: RateLimiter;
  registry: RunRegistry;
  runner: () => { execution: Execution; run: MissionRunner };
  schedule: (task: () => Promise<void>) => void;
  production: boolean;
  now?: () => Date;
  stream?: Pick<RunStreamOptions, "pollMs" | "heartbeatMs" | "idleHookMs">;
  connections?: (
    app: AppDatabase,
    session: GuestSession,
  ) => Promise<MissionConnections | undefined>;
  shipEnabled?: boolean;
  shipInstallations?: (workspaceId: string) => FindInstallation;
}

export type ApiErrorCode =
  | "no_pending_ship"
  | "forbidden_origin"
  | "unsupported_media_type"
  | "payload_too_large"
  | "invalid_json"
  | "invalid_request"
  | "invalid_url"
  | "rate_limited"
  | "not_found"
  | "run_finished"
  | "no_pending_plan"
  | "invalid_plan"
  | "forbidden"
  | "run_not_finished"
  | "invalid_step"
  | "unavailable"
  | "unauthorized"
  | "internal";

const MAX_BODY_BYTES = 8 * 1024;
const MAX_PLAN_BODY_BYTES = 64 * 1024;

export const NO_STORE = { "Cache-Control": "no-store" };

export function apiError(
  status: number,
  code: ApiErrorCode,
  message: string,
  extra: { issues?: string[]; headers?: Record<string, string> } = {},
): Response {
  return Response.json(
    { error: { code, message, ...(extra.issues === undefined ? {} : { issues: extra.issues }) } },
    { status, headers: { ...NO_STORE, ...extra.headers } },
  );
}

function notFound(): Response {
  return apiError(404, "not_found", "No run with that id is visible to this session.");
}

export const CreateRunRequestSchema = z
  .strictObject({
    missionId: z.enum(RUNNABLE_MISSION_IDS),
    input: z.strictObject({
      url: z.string().min(1).max(2048).optional(),
      focus: z.string().trim().min(1).max(500).optional(),
      department: z.string().trim().min(1).max(120).optional(),
      goal: z.string().trim().min(1).max(900).optional(),
      name: z.string().trim().min(1).max(80).optional(),
      opportunityId: z.string().trim().min(1).max(40).optional(),
      fromAuditRunId: z.string().max(100).optional(),
      ref: z
        .string()
        .trim()
        .regex(/^(?!.*\.\.)(?!\/)[\w./-]{1,200}$/)
        .optional(),
    }),
    parentRunId: z.uuid().optional(),
  })
  .superRefine((request, ctx) => {
    const buildOnly = ["goal", "name", "opportunityId", "fromAuditRunId"] as const;
    if (request.missionId !== "custom-goal" && request.input.url === undefined)
      ctx.addIssue({ code: "custom", path: ["input", "url"], message: "A URL is required" });
    if (request.missionId === "build-agent" || request.missionId === "custom-goal") {
      if (request.input.goal === undefined)
        ctx.addIssue({ code: "custom", path: ["input", "goal"], message: "A goal is required" });
      if (request.missionId === "build-agent") return;
      if (request.input.goal !== undefined && request.input.goal.length < 3)
        ctx.addIssue({ code: "custom", path: ["input", "goal"], message: "The goal is too short" });
      for (const key of [
        "focus",
        "department",
        "name",
        "opportunityId",
        "fromAuditRunId",
        "ref",
      ] as const)
        if (request.input[key] !== undefined)
          ctx.addIssue({ code: "custom", path: ["input", key], message: "Not for custom-goal" });
      return;
    }
    for (const key of buildOnly)
      if (request.input[key] !== undefined)
        ctx.addIssue({ code: "custom", path: ["input", key], message: "Only for build-agent" });
    if (request.missionId !== "repo-xray" && request.input.ref !== undefined)
      ctx.addIssue({ code: "custom", path: ["input", "ref"], message: "Only for repo-xray" });
    if (
      request.missionId === "repo-xray" &&
      (request.input.focus !== undefined || request.input.department !== undefined)
    )
      ctx.addIssue({ code: "custom", path: ["input"], message: "Repo X-ray takes a URL and ref" });
  });

export const GITHUB_URL_REJECTION =
  "Enter a public GitHub repository, for example github.com/owner/repo.";

function normaliseRunUrl(
  request: CreateRunRequest,
): { ok: true; url: string | undefined } | { ok: false; message: string } {
  if (request.input.url === undefined) return { ok: true, url: undefined };
  if (request.missionId === "repo-xray") {
    const repo = parseGithubRepoUrl(request.input.url);
    return repo === null
      ? { ok: false, message: GITHUB_URL_REJECTION }
      : { ok: true, url: `https://github.com/${repo.owner}/${repo.repo}` };
  }
  const url = normaliseCompanyUrl(request.input.url);
  return url.ok
    ? { ok: true, url: url.url }
    : { ok: false, message: COMPANY_URL_REJECTION_MESSAGES[url.reason] };
}

export const PlanDecisionRequestSchema = z.discriminatedUnion("decision", [
  z.strictObject({
    decision: z.literal("approved"),
    steps: z.array(z.unknown()).max(50).optional(),
  }),
  z.strictObject({
    decision: z.literal("rejected"),
    reason: z.string().trim().min(1).max(500).optional(),
  }),
]);

export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>;

export const ForkRunRequestSchema = z.strictObject({
  stepId: z.string().trim().min(1).max(120),
  objective: z.string().trim().min(1).max(MAX_FORK_OBJECTIVE_CHARS).optional(),
});

export type ForkRunRequest = z.infer<typeof ForkRunRequestSchema>;

function forwardedHost(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-host");
  if (forwarded !== null && forwarded !== "") return forwarded.split(",")[0]?.trim() ?? null;
  return request.headers.get("host");
}

export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = forwardedHost(request);
  if (origin === null || origin === "null" || host === null) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  if (first !== undefined && first !== "") return first;
  return request.headers.get("x-real-ip") ?? "unknown";
}

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (header === null) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

export function serializeSessionCookie(value: string, production: boolean): string {
  const options = sessionCookieOptions(production);
  return [
    `${SESSION_COOKIE}=${value}`,
    `Path=${options.path}`,
    `Max-Age=${options.maxAge}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(options.secure ? ["Secure"] : []),
  ].join("; ");
}

export function retryAfterSeconds(ms: number): string {
  return String(Math.max(1, Math.ceil(ms / 1000)));
}

export async function readJson(
  request: Request,
  maxBytes = MAX_BODY_BYTES,
): Promise<{ ok: true; value: unknown } | Response> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) {
    return apiError(415, "unsupported_media_type", "Send the request body as application/json.");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    return apiError(413, "payload_too_large", "The request body is too large.");
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return apiError(400, "invalid_json", "The request body is not valid JSON.");
  }
}

function allowedOrigin(request: Request): boolean {
  return isSameOrigin(request) || hasBearer(request);
}

export function unauthorized(): Response {
  return apiError(401, "unauthorized", "The API token is missing, invalid or revoked.", {
    headers: { "WWW-Authenticate": 'Bearer realm="delegate"' },
  });
}

export type StartRunResult = { ok: true; runId: string } | { ok: false; response: Response };

export async function startRunForSession(
  app: AppDatabase,
  session: GuestSession,
  request: CreateRunRequest,
  deps: ApiDeps,
  options: { autoApprovePlan: boolean; headers?: Record<string, string> },
): Promise<StartRunResult> {
  const headers = options.headers ?? {};
  const url = normaliseRunUrl(request);
  if (!url.ok)
    return { ok: false, response: apiError(400, "invalid_url", url.message, { headers }) };
  const quota = deps.guestLimiter.take(session.userId);
  if (!quota.ok) {
    return {
      ok: false,
      response: apiError(429, "rate_limited", "Demo runs are limited per hour. Try again later.", {
        headers: { "Retry-After": retryAfterSeconds(quota.retryAfterMs), ...headers },
      }),
    };
  }
  const parentRunId =
    request.parentRunId === undefined
      ? undefined
      : (await getRunRecord(app, session.userId, request.parentRunId))?.id;
  if (request.parentRunId !== undefined && parentRunId === undefined) {
    return {
      ok: false,
      response: apiError(400, "invalid_request", "The parent run is not visible to this session.", {
        headers,
      }),
    };
  }
  const input = missionInput(request, url.url, parentRunId);
  const runner = deps.runner();
  const { runId } = await createRunRecord(app, session, {
    missionId: request.missionId,
    input,
    execution: runner.execution,
    ...(parentRunId === undefined ? {} : { parentRunId }),
  });
  const automation = await readAutomation(app, session);
  const autoApprovePlan = options.autoApprovePlan || automation.autoApprovePlans;
  const connections =
    runner.execution === "live" && deps.connections !== undefined
      ? await deps.connections(app, session).catch((error: unknown) => {
          console.error(
            "loading connectors failed",
            runId,
            error instanceof Error ? error.name : "",
          );
          return undefined;
        })
      : undefined;
  const ctx = { runId, workspaceId: session.workspaceId, userId: session.userId };
  deps.schedule(() =>
    executeRun({
      app,
      ctx,
      missionId: request.missionId,
      input,
      runner: runner.run,
      registry: deps.registry,
      autoApprovePlan,
      ...(connections === undefined ? {} : { connections }),
      ...(runner.execution === "live" ? { lease: createDbLease(app, ctx) } : {}),
    }),
  );
  return { ok: true, runId };
}

export async function handleCreateRun(request: Request, deps: ApiDeps): Promise<Response> {
  if (!allowedOrigin(request)) {
    return apiError(403, "forbidden_origin", "Cross-origin requests cannot start runs.");
  }
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const parsed = CreateRunRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    return apiError(400, "invalid_request", "The run request is not valid.", {
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
      ),
    });
  }
  const url = normaliseRunUrl(parsed.data);
  if (!url.ok) return apiError(400, "invalid_url", url.message);

  const ipQuota = deps.ipLimiter.take(clientIp(request));
  if (!ipQuota.ok) {
    return apiError(429, "rate_limited", "Too many demo runs from this network. Try again later.", {
      headers: { "Retry-After": retryAfterSeconds(ipQuota.retryAfterMs) },
    });
  }

  try {
    const app = await deps.app();
    if (hasBearer(request)) {
      const session = await authenticateBearer(app, request);
      if (session === null) return unauthorized();
      const started = await startRunForSession(app, session, parsed.data, deps, {
        autoApprovePlan: false,
      });
      if (!started.ok) return started.response;
      return Response.json({ runId: started.runId }, { status: 201, headers: NO_STORE });
    }
    const secret = deps.secret();
    const { session, issued } = await resolveGuest(
      app,
      readCookie(request, SESSION_COOKIE),
      secret,
    );
    const cookieHeaders: Record<string, string> = issued
      ? { "Set-Cookie": serializeSessionCookie(signSession(session, secret), deps.production) }
      : {};
    const started = await startRunForSession(app, session, parsed.data, deps, {
      autoApprovePlan: readCookie(request, AUTO_APPROVE_COOKIE) === "1",
      headers: cookieHeaders,
    });
    if (!started.ok) return started.response;
    return Response.json(
      { runId: started.runId },
      { status: 201, headers: { ...NO_STORE, ...cookieHeaders } },
    );
  } catch (error: unknown) {
    console.error("create run failed", error);
    return apiError(500, "internal", "The run could not be created.");
  }
}

export function missionInput(
  request: CreateRunRequest,
  url: string | undefined,
  parentRunId: string | undefined,
): Record<string, unknown> {
  const { focus, department, goal, name, opportunityId, ref } = request.input;
  if (request.missionId === "custom-goal") return { goal, ...(url === undefined ? {} : { url }) };
  if (request.missionId === "repo-xray") {
    const tree =
      request.input.url === undefined ? undefined : parseGithubRepoUrl(request.input.url)?.ref;
    const chosen = ref ?? tree;
    return { url, ...(chosen === undefined ? {} : { ref: chosen }) };
  }
  if (request.missionId === "build-agent") {
    return {
      url,
      goal,
      ...(name === undefined ? {} : { name }),
      ...(opportunityId === undefined ? {} : { opportunityId }),
      ...(parentRunId === undefined ? {} : { fromAuditRunId: parentRunId }),
    };
  }
  return {
    url,
    ...(focus === undefined ? {} : { focus }),
    ...(department === undefined || request.missionId !== "automation-audit" ? {} : { department }),
  };
}

export async function callerFor(
  request: Request,
  deps: ApiDeps,
): Promise<{ app: AppDatabase; session: GuestSession; bearer: boolean } | Response> {
  const app = await deps.app();
  if (hasBearer(request)) {
    const session = await authenticateBearer(app, request);
    return session === null ? unauthorized() : { app, session, bearer: true };
  }
  const session = await readGuest(app, readCookie(request, SESSION_COOKIE), deps.secret());
  return session === null ? notFound() : { app, session, bearer: false };
}

export async function guestFor(
  request: Request,
  deps: ApiDeps,
): Promise<{ app: AppDatabase; session: GuestSession } | null> {
  const app = await deps.app();
  const session = await readGuest(app, readCookie(request, SESSION_COOKIE), deps.secret());
  return session === null ? null : { app, session };
}

async function freshRecord(
  app: AppDatabase,
  session: GuestSession,
  runId: string,
  deps: ApiDeps,
): Promise<RunRecord | null> {
  const record = await getRunRecord(app, session.userId, runId);
  if (record === null) return null;
  return reviveOrSweep(app, session.userId, record, deps);
}

export function runSummary(record: RunRecord) {
  const input = missionInputOf(record.input);
  return {
    id: record.id,
    mission: record.mission,
    target: runTarget(input),
    input,
    execution: record.execution,
    status: record.status,
    totals: record.totals,
    createdAt: record.createdAt.toISOString(),
    startedAt: record.startedAt?.toISOString() ?? null,
    finishedAt: record.finishedAt?.toISOString() ?? null,
    eventCount: record.eventCount,
    terminal: record.lastEventType !== null && isTerminalEventType(record.lastEventType),
  };
}

export type RunSummary = ReturnType<typeof runSummary>;

export async function handleGetRun(
  request: Request,
  runId: string,
  deps: ApiDeps,
): Promise<Response> {
  const guest = await callerFor(request, deps);
  if (guest instanceof Response) return guest;
  const record = await freshRecord(guest.app, guest.session, runId, deps);
  if (record === null) return notFound();
  if (new URL(request.url).searchParams.get("view") === "1") {
    const view = await buildRunView(guest.app, guest.session.userId, record);
    return Response.json({ run: runSummary(record), view }, { headers: NO_STORE });
  }
  return Response.json({ run: runSummary(record) }, { headers: NO_STORE });
}

export const LIST_RUNS_MAX = 50;

export async function handleListRuns(request: Request, deps: ApiDeps): Promise<Response> {
  const guest = await callerFor(request, deps);
  if (guest instanceof Response) return guest.status === 404 ? Response.json({ runs: [] }) : guest;
  const raw = Number(new URL(request.url).searchParams.get("limit") ?? "20");
  const limit = Number.isInteger(raw) ? Math.min(LIST_RUNS_MAX, Math.max(1, raw)) : 20;
  const rows = await listRuns(guest.app, guest.session, limit);
  return Response.json(
    {
      runs: rows.map((row) => ({
        id: row.id,
        mission: row.mission,
        target: row.target,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        finishedAt: row.finishedAt?.toISOString() ?? null,
      })),
    },
    { headers: NO_STORE },
  );
}

export async function handleRunEvents(
  request: Request,
  runId: string,
  deps: ApiDeps,
): Promise<Response> {
  const guest = await callerFor(request, deps);
  if (guest instanceof Response) return guest;
  const { app, session } = guest;
  const record = await freshRecord(app, session, runId, deps);
  if (record === null) return notFound();

  const url = new URL(request.url);
  const afterSeq = parseResumeSeq(
    request.headers.get("last-event-id"),
    url.searchParams.get("after"),
  );
  const terminal = record.lastEventType !== null && isTerminalEventType(record.lastEventType);
  if (terminal && afterSeq >= record.eventCount) {
    return new Response(null, { status: 204, headers: NO_STORE });
  }

  const stream = createRunEventStream({
    afterSeq,
    signal: request.signal,
    ...deps.stream,
    source: {
      load: (after) => readEvents(app, session.userId, runId, after),
      onIdle: async () => {
        await freshRecord(app, session, runId, deps);
      },
    },
  });
  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

export async function handleCancelRun(
  request: Request,
  runId: string,
  deps: ApiDeps,
): Promise<Response> {
  if (!allowedOrigin(request)) {
    return apiError(403, "forbidden_origin", "Cross-origin requests cannot stop runs.");
  }
  const guest = await callerFor(request, deps);
  if (guest instanceof Response) return guest;
  const record = await getRunRecord(guest.app, guest.session.userId, runId);
  if (record === null) return notFound();
  try {
    await appendEvent(
      guest.app,
      { runId, workspaceId: record.workspaceId, userId: guest.session.userId },
      {
        type: "run.failed",
        payload: { error: { code: "cancelled", message: "cancelled by user" } },
      },
    );
  } catch (error: unknown) {
    if (error instanceof RunAlreadyTerminalError) {
      return apiError(409, "run_finished", "This run has already finished.");
    }
    throw error;
  }
  const aborted = deps.registry.abort(runId, "cancelled by user");
  return Response.json({ cancelled: true, aborted }, { headers: NO_STORE });
}

export async function handleGetArtifact(
  request: Request,
  runId: string,
  artifactId: string,
  deps: ApiDeps,
): Promise<Response> {
  const guest = await callerFor(request, deps);
  if (guest instanceof Response) return guest;
  if (artifactId.length > 200) return notFound();
  const artifact = await artifactContent(guest.app, guest.session.userId, runId, artifactId);
  if (artifact === null) return apiError(404, "not_found", "No artifact with that id.");
  return Response.json({ artifact }, { headers: NO_STORE });
}

export async function handlePlanDecision(
  request: Request,
  runId: string,
  deps: ApiDeps,
): Promise<Response> {
  if (!allowedOrigin(request)) {
    return apiError(403, "forbidden_origin", "Cross-origin requests cannot decide plans.");
  }
  const guest = await callerFor(request, deps);
  if (guest instanceof Response) return guest;
  const record = await getRunRecord(guest.app, guest.session.userId, runId);
  if (record === null) return notFound();
  const body = await readJson(request, MAX_PLAN_BODY_BYTES);
  if (body instanceof Response) return body;
  const parsed = PlanDecisionRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    return apiError(400, "invalid_request", "The plan decision is not valid.", {
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
      ),
    });
  }
  if (record.lastEventType !== null && isTerminalEventType(record.lastEventType)) {
    return apiError(409, "run_finished", "This run has already finished.");
  }
  const pending = await pendingPlanApproval(guest.app, guest.session.userId, runId);
  if (pending === null) {
    return apiError(409, "no_pending_plan", "This run has no plan waiting for approval.");
  }
  const ctx = { runId, workspaceId: record.workspaceId, userId: guest.session.userId };
  let details: Parameters<typeof recordPlanDecision>[3];
  if (parsed.data.decision === "approved") {
    if (parsed.data.steps === undefined) {
      details = { decision: "approved" };
    } else {
      const edit = validatePlanEdit(pending.steps, parsed.data.steps);
      if (!edit.ok) {
        return apiError(400, "invalid_plan", "The edited plan is not valid.", {
          issues: edit.issues,
        });
      }
      details =
        JSON.stringify(edit.steps) === JSON.stringify(pending.steps)
          ? { decision: "approved" }
          : { decision: "approved", steps: edit.steps };
    }
  } else {
    details =
      parsed.data.reason === undefined
        ? { decision: "rejected" }
        : { decision: "rejected", reason: parsed.data.reason };
  }
  try {
    await recordPlanDecision(guest.app, ctx, pending.approvalId, details);
  } catch (error: unknown) {
    if (error instanceof PlanDecisionError) {
      return error.code === "forbidden"
        ? apiError(403, "forbidden", "Your role cannot decide this plan.")
        : apiError(409, "no_pending_plan", "This plan was already decided.");
    }
    console.error("plan decision failed", error);
    return apiError(500, "internal", "The decision could not be recorded.");
  }
  return Response.json(
    { decision: details.decision, edited: "steps" in details && details.steps !== undefined },
    { headers: NO_STORE },
  );
}

function isRunnableMission(mission: string): mission is (typeof RUNNABLE_MISSION_IDS)[number] {
  return (RUNNABLE_MISSION_IDS as readonly string[]).includes(mission);
}

export function forkRefusalResponse(refusal: Extract<ForkPlan, { ok: false }>): Response {
  switch (refusal.reason) {
    case "run_not_finished":
      return apiError(409, "run_not_finished", refusal.message);
    case "unknown_step":
    case "step_not_completed":
    case "invalid_objective":
      return apiError(400, "invalid_step", refusal.message);
  }
}

export async function handleForkRun(
  request: Request,
  runId: string,
  deps: ApiDeps,
): Promise<Response> {
  if (!allowedOrigin(request)) {
    return apiError(403, "forbidden_origin", "Cross-origin requests cannot fork runs.");
  }
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const parsed = ForkRunRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    return apiError(400, "invalid_request", "The fork request is not valid.", {
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
      ),
    });
  }
  const ipQuota = deps.ipLimiter.take(clientIp(request));
  if (!ipQuota.ok) {
    return apiError(429, "rate_limited", "Too many demo runs from this network. Try again later.", {
      headers: { "Retry-After": retryAfterSeconds(ipQuota.retryAfterMs) },
    });
  }
  try {
    const guest = await callerFor(request, deps);
    if (guest instanceof Response) return guest;
    const { app, session } = guest;
    const parent = await getRunRecord(app, session.userId, runId);
    if (parent?.workspaceId !== session.workspaceId) return notFound();
    const missionId = parent.mission;
    if (!isRunnableMission(missionId)) {
      return apiError(400, "invalid_request", "This mission cannot be forked.");
    }
    const started = Date.now();
    const fork = planRunFork(await readAllEvents(app, session.userId, parent.id), parsed.data);
    if (!fork.ok) return forkRefusalResponse(fork);
    const quota = deps.guestLimiter.take(session.userId);
    if (!quota.ok) {
      return apiError(429, "rate_limited", "Demo runs are limited per hour. Try again later.", {
        headers: { "Retry-After": retryAfterSeconds(quota.retryAfterMs) },
      });
    }
    const runner = deps.runner();
    const created = await createForkRecord(app, session, parent, fork, runner.execution);
    const ctx = { runId: created.runId, workspaceId: session.workspaceId, userId: session.userId };
    deps.schedule(() =>
      executeRun({
        app,
        ctx,
        missionId,
        input: missionInputOf(parent.input),
        runner: runner.run,
        registry: deps.registry,
        resumeFrom: created.events,
        ...(runner.execution === "live" ? { lease: createDbLease(app, ctx) } : {}),
      }),
    );
    return Response.json(
      {
        runId: created.runId,
        parentRunId: parent.id,
        stepId: fork.stepId,
        seededEvents: created.origin.seededThrough - 1,
        reusedSteps: fork.reusedSteps,
        seedMs: Date.now() - started,
      },
      { status: 201, headers: NO_STORE },
    );
  } catch (error: unknown) {
    console.error("fork run failed", runId, error);
    return apiError(500, "internal", "The run could not be forked.");
  }
}
