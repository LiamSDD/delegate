import type { RunEvent as StoredRunEvent } from "@delegate/runtime";
import {
  API_BASE_PATH,
  type ArtifactRef,
  type ChatAnswer,
  type OperationBody,
  type OperationId,
  type OperationParams,
  type OperationQuery,
  type OperationResponse,
  type Run,
} from "@delegate/sdk/contract";

import {
  type ApiDeps,
  cancelRun,
  clientIp,
  CreateRunRequestSchema,
  retryAfterSeconds,
  runSummary,
  startRunForSession,
} from "../api";
import type { TokenSession } from "../api-tokens";
import { type AssistantStores, ensureLoaded, findAssistant, listAssistants } from "../assistants";
import { answerStream, type ChatDeps } from "../chat";
import type { AppDatabase } from "../db";
import { reviveOrSweep } from "../durable";
import { pendingPlanApproval, PlanDecisionError, recordPlanDecision } from "../plan-approval";
import { buildRunView } from "../run-view-api";
import {
  artifactContent,
  getRunRecord,
  isTerminalEventType,
  readAllEvents,
  readEvents,
  type RunRecord,
} from "../runs";
import type { RateLimiter } from "../session";
import { createRunEventStream, parseResumeSeq, SSE_HEADERS } from "../sse";
import { fromLegacyResponse, V1Error, zodIssues } from "./errors";
import type { RequestLimiter } from "./rate-limit";
import { listRunsPage } from "./run-list";

export interface V1Deps {
  api: ApiDeps;
  limiter: RequestLimiter;
  chat: {
    limiter: RateLimiter;
    answer: ChatDeps["answer"];
    stores: () => AssistantStores;
  };
}

export type AuthenticatedOperationId = Exclude<OperationId, "getOpenApi">;

export interface V1Context<Id extends AuthenticatedOperationId> {
  request: Request;
  app: AppDatabase;
  session: TokenSession;
  deps: V1Deps;
  origin: string;
  wantsEventStream: boolean;
  params: OperationParams<Id>;
  query: OperationQuery<Id>;
  body: OperationBody<Id>;
}

export type V1Result<Id extends AuthenticatedOperationId> =
  { body: OperationResponse<Id>; headers?: Record<string, string> } | { stream: Response };

type Handler<Id extends AuthenticatedOperationId> = (ctx: V1Context<Id>) => Promise<V1Result<Id>>;

type AnyContext = V1Context<AuthenticatedOperationId>;

function notFound(what = "run"): V1Error {
  return new V1Error("not_found", `No ${what} with that id is visible to this token.`);
}

export function inTokenWorkspace(
  session: Pick<TokenSession, "workspaceId">,
  record: Pick<RunRecord, "workspaceId"> | null,
): boolean {
  return record !== null && record.workspaceId === session.workspaceId;
}

async function visibleRun(
  ctx: Pick<AnyContext, "app" | "session" | "deps">,
  runId: string,
  options: { revive: boolean },
): Promise<RunRecord> {
  const found = await getRunRecord(ctx.app, ctx.session.userId, runId);
  if (found === null || !inTokenWorkspace(ctx.session, found)) throw notFound();
  if (!options.revive) return found;
  const fresh = await reviveOrSweep(ctx.app, ctx.session.userId, found, ctx.deps.api);
  if (fresh === null) throw notFound();
  return fresh;
}

function isTerminal(record: RunRecord): boolean {
  return record.lastEventType !== null && isTerminalEventType(record.lastEventType);
}

async function runResource(
  ctx: Pick<AnyContext, "app" | "session" | "origin">,
  record: RunRecord,
): Promise<Run> {
  const view = await buildRunView(ctx.app, ctx.session.userId, record);
  const summary = runSummary(record);
  return {
    ...view,
    target: summary.target,
    execution: summary.execution,
    startedAt: summary.startedAt,
    webUrl: `${ctx.origin}/runs/${record.id}`,
  };
}

const createRun: Handler<"createRun"> = async (ctx) => {
  const parsed = CreateRunRequestSchema.safeParse(ctx.body);
  if (!parsed.success)
    throw new V1Error("invalid_request", "The run request is not valid.", {
      issues: zodIssues(parsed.error),
    });
  const network = ctx.deps.api.ipLimiter.take(clientIp(ctx.request));
  if (!network.ok)
    throw new V1Error("rate_limited", "Too many runs from this network. Try again later.", {
      headers: { "Retry-After": retryAfterSeconds(network.retryAfterMs) },
    });
  const started = await startRunForSession(ctx.app, ctx.session, parsed.data, ctx.deps.api, {
    autoApprovePlan: false,
  });
  if (!started.ok) throw await fromLegacyResponse(started.response);
  const record = await getRunRecord(ctx.app, ctx.session.userId, started.runId);
  if (record === null) throw new Error(`run ${started.runId} was created but is not readable`);
  return {
    body: await runResource(ctx, record),
    headers: { Location: `${API_BASE_PATH}/runs/${record.id}` },
  };
};

const listRuns: Handler<"listRuns"> = async (ctx) => ({
  body: await listRunsPage(ctx.app, ctx.session, ctx.query, ctx.origin),
});

const getRun: Handler<"getRun"> = async (ctx) => ({
  body: await runResource(ctx, await visibleRun(ctx, ctx.params.runId, { revive: true })),
});

const cancel: Handler<"cancelRun"> = async (ctx) => {
  const record = await visibleRun(ctx, ctx.params.runId, { revive: false });
  const cancelled = await cancelRun(ctx.app, ctx.session, record, ctx.deps.api);
  if (!cancelled.ok) throw new V1Error("run_finished", "This run has already finished.");
  const after = await getRunRecord(ctx.app, ctx.session.userId, record.id);
  return { body: await runResource(ctx, after ?? record) };
};

function publicEvent(event: StoredRunEvent) {
  return {
    runId: event.runId,
    seq: event.seq,
    at: event.at,
    type: event.type,
    ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
    ...(event.agentId === undefined ? {} : { agentId: event.agentId }),
    payload: event.payload as Record<string, unknown>,
  };
}

const listRunEvents: Handler<"listRunEvents"> = async (ctx) => {
  const { app, session } = ctx;
  const runId = ctx.params.runId;
  const record = await visibleRun(ctx, runId, { revive: true });
  if (ctx.wantsEventStream) {
    const afterSeq = parseResumeSeq(
      ctx.request.headers.get("last-event-id"),
      String(ctx.query.after),
    );
    if (isTerminal(record) && afterSeq >= record.eventCount)
      return { stream: new Response(null, { status: 204 }) };
    const stream = createRunEventStream({
      afterSeq,
      signal: ctx.request.signal,
      ...ctx.deps.api.stream,
      source: {
        load: (after) => readEvents(app, session.userId, runId, after),
        onIdle: async () => {
          await visibleRun(ctx, runId, { revive: true }).catch(() => undefined);
        },
      },
    });
    return { stream: new Response(stream, { status: 200, headers: SSE_HEADERS }) };
  }
  const { after, limit } = ctx.query;
  const rows = await readEvents(app, session.userId, runId, after, limit + 1);
  const page = rows.slice(0, limit);
  return {
    body: {
      data: page.map(publicEvent),
      nextAfter: page.at(-1)?.seq ?? after,
      hasMore: rows.length > limit,
      terminal: isTerminal(record),
    },
  };
};

function decidePlan(decision: "approved" | "rejected") {
  return async (
    ctx: V1Context<"approvePlan"> | V1Context<"rejectPlan">,
  ): Promise<V1Result<"approvePlan">> => {
    const runId = ctx.params.runId;
    const record = await visibleRun(ctx, runId, { revive: true });
    if (isTerminal(record)) throw new V1Error("run_finished", "This run has already finished.");
    const pending = await pendingPlanApproval(ctx.app, ctx.session.userId, runId);
    if (pending === null)
      throw new V1Error("no_pending_plan", "This run has no plan waiting for a decision.");
    const reason = "reason" in ctx.body ? ctx.body.reason : undefined;
    try {
      await recordPlanDecision(
        ctx.app,
        { runId, workspaceId: record.workspaceId, userId: ctx.session.userId },
        pending.approvalId,
        decision === "approved" || reason === undefined ? { decision } : { decision, reason },
      );
    } catch (error) {
      if (!(error instanceof PlanDecisionError)) throw error;
      throw error.code === "forbidden"
        ? new V1Error("forbidden", "This token's user cannot decide this plan.")
        : new V1Error("no_pending_plan", "This plan was already decided.");
    }
    return { body: { runId, decision } };
  };
}

export function artifactRefs(events: readonly StoredRunEvent[]): ArtifactRef[] {
  const refs = new Map<string, ArtifactRef>();
  for (const event of events) {
    if (event.type === "artifact.created") {
      refs.set(event.payload.artifactId, {
        artifactId: event.payload.artifactId,
        kind: event.payload.kind,
        title: event.payload.title,
        version: event.payload.version,
      });
    } else if (event.type === "artifact.updated") {
      const known = refs.get(event.payload.artifactId);
      if (known !== undefined)
        refs.set(event.payload.artifactId, {
          ...known,
          version: event.payload.version,
          ...(event.payload.title === undefined ? {} : { title: event.payload.title }),
        });
    }
  }
  return [...refs.values()];
}

const listArtifacts: Handler<"listArtifacts"> = async (ctx) => {
  const record = await visibleRun(ctx, ctx.params.runId, { revive: false });
  return {
    body: { data: artifactRefs(await readAllEvents(ctx.app, ctx.session.userId, record.id)) },
  };
};

const getArtifact: Handler<"getArtifact"> = async (ctx) => {
  const record = await visibleRun(ctx, ctx.params.runId, { revive: false });
  const artifact = await artifactContent(
    ctx.app,
    ctx.session.userId,
    record.id,
    ctx.params.artifactId,
  );
  if (artifact === null) throw notFound("artifact");
  return { body: artifact };
};

const listAssistantsHandler: Handler<"listAssistants"> = async (ctx) => {
  const rows = await listAssistants(ctx.app, ctx.session, ctx.query.limit);
  return {
    body: {
      data: rows.map((row) => ({
        id: row.id,
        name: row.name,
        url: row.url,
        status: row.status,
        passRate: row.passRate,
        pages: row.pages,
        runId: row.runId,
        createdAt: row.createdAt,
        webUrl: `${ctx.origin}/agents/${row.id}`,
      })),
    },
  };
};

type AnswerEvents = ReturnType<ChatDeps["answer"]>;

async function collectAnswer(events: AnswerEvents): Promise<ChatAnswer> {
  let refusal: ChatAnswer["refusal"] = null;
  let retryAfterMs: number | undefined;
  for await (const event of events) {
    if (event.type === "refusal") {
      refusal = { reason: event.reason, message: event.message };
      retryAfterMs = event.retryAfterMs;
      continue;
    }
    if (event.type !== "done") continue;
    if (refusal?.reason === "unavailable") throw new V1Error("unavailable", refusal.message);
    if (refusal?.reason === "rate_limited")
      throw new V1Error("rate_limited", refusal.message, {
        headers: { "Retry-After": retryAfterSeconds(retryAfterMs ?? 60_000) },
      });
    if (refusal?.reason === "invalid_request")
      throw new V1Error("invalid_request", refusal.message);
    return {
      answer: event.answer,
      citations: event.citations.map((citation) => ({
        index: citation.index,
        chunkId: citation.chunkId,
        url: citation.url,
        ...(citation.title === undefined ? {} : { title: citation.title }),
        ...(citation.quote === undefined ? {} : { quote: citation.quote }),
      })),
      grounded: event.grounded,
      refused: event.refused,
      refusal,
      servedBy: event.servedBy ?? null,
      usage: event.usage,
      durationMs: event.durationMs,
    };
  }
  throw new V1Error("unavailable", "The assistant did not finish its answer. Try again shortly.");
}

const chatWithAssistant: Handler<"chatWithAssistant"> = async (ctx) => {
  const assistantId = ctx.params.assistantId;
  const view = await findAssistant(ctx.app, ctx.session.userId, assistantId);
  if (
    view === null ||
    !inTokenWorkspace(ctx.session, await getRunRecord(ctx.app, ctx.session.userId, view.runId))
  )
    throw notFound("assistant");
  const quota = ctx.deps.chat.limiter.take(ctx.session.userId);
  if (!quota.ok)
    throw new V1Error("rate_limited", "Too many questions for now. Try again later.", {
      headers: { "Retry-After": retryAfterSeconds(quota.retryAfterMs) },
    });
  await ensureLoaded(ctx.deps.chat.stores(), view);
  const controller = new AbortController();
  const events = ctx.deps.chat.answer({
    assistantId,
    question: ctx.body.question,
    history: ctx.body.history,
    signal: AbortSignal.any([ctx.request.signal, controller.signal]),
    scope: { userId: ctx.session.userId, workspaceId: view.workspaceId },
  });
  if (ctx.wantsEventStream)
    return {
      stream: new Response(answerStream(events, controller), {
        status: 200,
        headers: SSE_HEADERS,
      }),
    };
  return { body: await collectAnswer(events) };
};

export const HANDLERS: { [Id in AuthenticatedOperationId]: Handler<Id> } = {
  createRun,
  listRuns,
  getRun,
  cancelRun: cancel,
  listRunEvents,
  approvePlan: decidePlan("approved"),
  rejectPlan: decidePlan("rejected"),
  listArtifacts,
  getArtifact,
  listAssistants: listAssistantsHandler,
  chatWithAssistant,
};
