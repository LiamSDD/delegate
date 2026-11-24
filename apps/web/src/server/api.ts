import { z } from "zod";

import { COMPANY_URL_REJECTION_MESSAGES, normaliseCompanyUrl } from "@/lib/runs/company-url";

import type { AppDatabase } from "./db";
import { executeRun } from "./execute-run";
import type { MissionRunner } from "./mission-runner";
import type { RunRegistry } from "./run-registry";
import {
  appendEvent,
  artifactContent,
  createRunRecord,
  type Execution,
  getRunRecord,
  isTerminalEventType,
  missionInputOf,
  readEvents,
  RunAlreadyTerminalError,
  type RunRecord,
  sweepIfStale,
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
import { createRunEventStream, parseResumeSeq, type RunStreamOptions, SSE_HEADERS } from "./sse";

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
}

export type ApiErrorCode =
  | "forbidden_origin"
  | "unsupported_media_type"
  | "payload_too_large"
  | "invalid_json"
  | "invalid_request"
  | "invalid_url"
  | "rate_limited"
  | "not_found"
  | "run_finished"
  | "unavailable"
  | "internal";

const MAX_BODY_BYTES = 8 * 1024;

const NO_STORE = { "Cache-Control": "no-store" };

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

export const CreateRunRequestSchema = z.strictObject({
  missionId: z.literal("company-xray"),
  input: z.strictObject({
    url: z.string().min(1).max(2048),
    focus: z.string().trim().min(1).max(500).optional(),
  }),
});

export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>;

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

function retryAfterSeconds(ms: number): string {
  return String(Math.max(1, Math.ceil(ms / 1000)));
}

async function readJson(request: Request): Promise<{ ok: true; value: unknown } | Response> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) {
    return apiError(415, "unsupported_media_type", "Send the request body as application/json.");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    return apiError(413, "payload_too_large", "The request body is too large.");
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return apiError(400, "invalid_json", "The request body is not valid JSON.");
  }
}

export async function handleCreateRun(request: Request, deps: ApiDeps): Promise<Response> {
  if (!isSameOrigin(request)) {
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
  const url = normaliseCompanyUrl(parsed.data.input.url);
  if (!url.ok) return apiError(400, "invalid_url", COMPANY_URL_REJECTION_MESSAGES[url.reason]);

  const ipQuota = deps.ipLimiter.take(clientIp(request));
  if (!ipQuota.ok) {
    return apiError(429, "rate_limited", "Too many demo runs from this network. Try again later.", {
      headers: { "Retry-After": retryAfterSeconds(ipQuota.retryAfterMs) },
    });
  }

  try {
    const app = await deps.app();
    const secret = deps.secret();
    const { session, issued } = await resolveGuest(
      app,
      readCookie(request, SESSION_COOKIE),
      secret,
    );
    const quota = deps.guestLimiter.take(session.userId);
    const cookieHeaders: Record<string, string> = issued
      ? { "Set-Cookie": serializeSessionCookie(signSession(session, secret), deps.production) }
      : {};
    if (!quota.ok) {
      return apiError(429, "rate_limited", "Demo runs are limited per hour. Try again later.", {
        headers: { "Retry-After": retryAfterSeconds(quota.retryAfterMs), ...cookieHeaders },
      });
    }

    const input = {
      url: url.url,
      ...(parsed.data.input.focus === undefined ? {} : { focus: parsed.data.input.focus }),
    };
    const runner = deps.runner();
    const { runId } = await createRunRecord(app, session, {
      missionId: parsed.data.missionId,
      input,
      execution: runner.execution,
    });
    deps.schedule(() =>
      executeRun({
        app,
        ctx: { runId, workspaceId: session.workspaceId, userId: session.userId },
        missionId: parsed.data.missionId,
        input,
        runner: runner.run,
        registry: deps.registry,
      }),
    );
    return Response.json({ runId }, { status: 201, headers: { ...NO_STORE, ...cookieHeaders } });
  } catch (error: unknown) {
    console.error("create run failed", error);
    return apiError(500, "internal", "The run could not be created.");
  }
}

async function guestFor(
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
  const swept = await sweepIfStale(app, session.userId, record, deps.now?.() ?? new Date());
  if (!swept) return record;
  deps.registry.abort(runId, "worker lost");
  return getRunRecord(app, session.userId, runId);
}

export function runSummary(record: RunRecord) {
  const input = missionInputOf(record.input);
  const url = typeof input.url === "string" ? input.url : null;
  return {
    id: record.id,
    mission: record.mission,
    target: url === null ? null : new URL(url).hostname.replace(/^www\./, ""),
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
  const guest = await guestFor(request, deps);
  if (guest === null) return notFound();
  const record = await freshRecord(guest.app, guest.session, runId, deps);
  if (record === null) return notFound();
  return Response.json({ run: runSummary(record) }, { headers: NO_STORE });
}

export async function handleRunEvents(
  request: Request,
  runId: string,
  deps: ApiDeps,
): Promise<Response> {
  const guest = await guestFor(request, deps);
  if (guest === null) return notFound();
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
  if (!isSameOrigin(request)) {
    return apiError(403, "forbidden_origin", "Cross-origin requests cannot stop runs.");
  }
  const guest = await guestFor(request, deps);
  if (guest === null) return notFound();
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
  const guest = await guestFor(request, deps);
  if (guest === null) return notFound();
  if (artifactId.length > 200) return notFound();
  const artifact = await artifactContent(guest.app, guest.session.userId, runId, artifactId);
  if (artifact === null) return apiError(404, "not_found", "No artifact with that id.");
  return Response.json({ artifact }, { headers: NO_STORE });
}
