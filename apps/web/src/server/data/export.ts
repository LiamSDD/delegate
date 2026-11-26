import { artifacts, recordAudit, runEvents, runs, withTenant } from "@delegate/db";
import { and, asc, desc, eq, gt } from "drizzle-orm";

import { type ApiDeps, apiError, guestFor, NO_STORE } from "../api";
import { listApiTokens } from "../api-tokens";
import { listConnectors } from "../connectors";
import { guardWebMutation } from "../control/http";
import { workspaceOverview } from "../control/workspace";
import type { AppDatabase } from "../db";
import { listInstallations } from "../github-connect";
import { createRateLimiter, type GuestSession, type RateLimiter } from "../session";
import { readAutomation } from "../workspace-settings";

export const EXPORT_FORMAT = "delegate.workspace-export";
export const EXPORT_VERSION = 1;
export const EXPORT_MAX_BYTES = 32 * 1024 * 1024;
export const EXPORT_MIN_BYTES = 8 * 1024;
export const EXPORT_MAX_DURATION_MS = 240_000;
export const EXPORT_EVENT_PAGE = 500;
export const EXPORT_MAX_RUNS = 5_000;
export const EXPORTS_PER_HOUR = 6;
export const DATA_EXPORTED_ACTION = "workspace.data_exported";

const TRAILER_RESERVE_BYTES = 2_048;
const OMITTED_RUNS_LISTED = 20;

export type TruncationReason = "size_limit" | "time_limit";

export interface ExportTruncation {
  reason: TruncationReason;
  message: string;
  runsIncluded: number;
  runsOmitted: number;
  omittedRunIds: string[];
  partialRunId: string | null;
}

export interface ExportLimits {
  maxBytes: number;
  maxDurationMs: number;
  now: () => number;
}

export const DEFAULT_EXPORT_LIMITS: ExportLimits = {
  maxBytes: EXPORT_MAX_BYTES,
  maxDurationMs: EXPORT_MAX_DURATION_MS,
  now: Date.now,
};

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function megabytes(value: number): string {
  return `${String(Math.round((value / (1024 * 1024)) * 10) / 10)} MiB`;
}

function truncationMessage(reason: TruncationReason, limits: ExportLimits): string {
  return reason === "size_limit"
    ? `The export stopped at its ${megabytes(limits.maxBytes)} size limit. Runs are written newest first; the ones listed here are missing or incomplete.`
    : `The export stopped at its ${String(Math.round(limits.maxDurationMs / 1000))} second time limit. Runs are written newest first; the ones listed here are missing or incomplete.`;
}

function createBudget(limits: ExportLimits) {
  const startedAt = limits.now();
  const room = limits.maxBytes - TRAILER_RESERVE_BYTES;
  let written = 0;
  let stopped: TruncationReason | null = null;
  return {
    stopped: (): TruncationReason | null => stopped,
    fits: (chunk: string): boolean => {
      if (stopped !== null) return false;
      if (limits.now() - startedAt > limits.maxDurationMs) stopped = "time_limit";
      else if (written + bytes(chunk) > room) stopped = "size_limit";
      return stopped === null;
    },
    count: (chunk: string): string => {
      written += bytes(chunk);
      return chunk;
    },
  };
}

async function header(app: AppDatabase, session: GuestSession, limits: ExportLimits) {
  const [workspace, automation, connectors, tokens, installations] = await Promise.all([
    workspaceOverview(app, session),
    readAutomation(app, session),
    listConnectors(app, session),
    listApiTokens(app, session),
    listInstallations(app, session),
  ]);
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date(limits.now()).toISOString(),
    limits: { maxBytes: limits.maxBytes, maxDurationMs: limits.maxDurationMs },
    workspace:
      workspace === null
        ? { id: session.workspaceId }
        : {
            id: workspace.id,
            name: workspace.name,
            tier: workspace.tier,
            createdAt: workspace.createdAt.toISOString(),
            retentionDays: workspace.retentionDays,
          },
    settings: {
      autoApprovePlans: automation.autoApprovePlans,
      preapprovedTools: automation.preapprovedTools,
      runsPausedAt: workspace?.runsPausedAt?.toISOString() ?? null,
    },
    connections: {
      note: "Secrets and token values are never stored in readable form and are not part of an export.",
      connectors: connectors.map((connector) => ({
        name: connector.name,
        url: connector.url,
        hasSecret: connector.hasSecret,
        tools: connector.tools.map((tool) => ({ name: tool.name, readOnly: tool.readOnly })),
      })),
      apiTokens: tokens.map((token) => ({
        name: token.name,
        prefix: token.prefix,
        createdAt: token.createdAt,
        lastUsedAt: token.lastUsedAt,
        revokedAt: token.revokedAt,
      })),
      githubInstallations: installations.map((installation) => ({
        accountLogin: installation.accountLogin,
        repositorySelection: installation.repositorySelection,
        repositories: installation.repositories,
      })),
    },
  };
}

export async function* exportChunks(
  app: AppDatabase,
  session: GuestSession,
  limits: ExportLimits = DEFAULT_EXPORT_LIMITS,
): AsyncGenerator<string> {
  if (limits.maxBytes < EXPORT_MIN_BYTES)
    throw new Error(`An export needs room for at least ${String(EXPORT_MIN_BYTES)} bytes`);
  const budget = createBudget(limits);
  const { fits, count } = budget;

  const head = JSON.stringify(await header(app, session, limits));
  yield count(`${head.slice(0, -1)},\n"runs":[`);

  const listed = await withTenant(app.db, session.userId, (tx) =>
    tx
      .select({
        id: runs.id,
        mission: runs.mission,
        status: runs.status,
        input: runs.input,
        totals: runs.totals,
        createdAt: runs.createdAt,
        startedAt: runs.startedAt,
        finishedAt: runs.finishedAt,
        parentRunId: runs.parentRunId,
        forkedFromSeq: runs.forkedFromSeq,
      })
      .from(runs)
      .where(eq(runs.workspaceId, session.workspaceId))
      .orderBy(desc(runs.createdAt), asc(runs.id))
      .limit(EXPORT_MAX_RUNS),
  );

  let included = 0;
  let partialRunId: string | null = null;
  for (const run of listed) {
    const opening = `${included === 0 ? "\n" : ",\n"}${JSON.stringify(run).slice(0, -1)},"artifacts":[`;
    const closing = (truncated: boolean) => `\n],"truncated":${String(truncated)}}`;
    if (!fits(`${opening}\n],"events":[${closing(true)}`)) break;
    yield count(opening);
    included += 1;

    const stored = await withTenant(app.db, session.userId, (tx) =>
      tx
        .select({
          id: artifacts.id,
          kind: artifacts.kind,
          title: artifacts.title,
          version: artifacts.version,
          createdAt: artifacts.createdAt,
          content: artifacts.content,
        })
        .from(artifacts)
        .where(and(eq(artifacts.runId, run.id), eq(artifacts.workspaceId, session.workspaceId)))
        .orderBy(asc(artifacts.createdAt), asc(artifacts.id)),
    );
    let first = true;
    for (const artifact of stored) {
      const line = `${first ? "\n" : ",\n"}${JSON.stringify(artifact)}`;
      if (!fits(`${line}\n],"events":[${closing(true)}`)) break;
      yield count(line);
      first = false;
    }
    yield count(`\n],"events":[`);

    first = true;
    let afterSeq = 0;
    while (budget.stopped() === null) {
      const page = await withTenant(app.db, session.userId, (tx) =>
        tx
          .select({
            seq: runEvents.seq,
            type: runEvents.type,
            at: runEvents.createdAt,
            stepId: runEvents.stepId,
            agentId: runEvents.agentId,
            payload: runEvents.payload,
          })
          .from(runEvents)
          .where(
            and(
              eq(runEvents.runId, run.id),
              eq(runEvents.workspaceId, session.workspaceId),
              gt(runEvents.seq, afterSeq),
            ),
          )
          .orderBy(asc(runEvents.seq))
          .limit(EXPORT_EVENT_PAGE),
      );
      for (const event of page) {
        const line = `${first ? "\n" : ",\n"}${JSON.stringify(event)}`;
        if (!fits(`${line}${closing(true)}`)) break;
        yield count(line);
        first = false;
        afterSeq = event.seq;
      }
      if (page.length < EXPORT_EVENT_PAGE) break;
    }
    const cut = budget.stopped() !== null;
    if (cut) partialRunId = run.id;
    yield count(closing(cut));
    if (cut) break;
  }

  const omitted = listed.slice(included).map((run) => run.id);
  const stopped = budget.stopped();
  const truncation: ExportTruncation | null =
    stopped === null
      ? null
      : {
          reason: stopped,
          message: truncationMessage(stopped, limits),
          runsIncluded: included,
          runsOmitted: omitted.length,
          omittedRunIds: omitted.slice(0, OMITTED_RUNS_LISTED),
          partialRunId,
        };
  yield count(`\n],\n"truncated":${JSON.stringify(truncation)},\n"complete":true}\n`);
}

export interface ExportDeps extends ApiDeps {
  exportLimiter: RateLimiter;
  exportLimits?: ExportLimits;
}

const limiterHolder = globalThis as typeof globalThis & { __delegateExportLimiter?: RateLimiter };

export function exportLimiter(): RateLimiter {
  limiterHolder.__delegateExportLimiter ??= createRateLimiter({
    limit: EXPORTS_PER_HOUR,
    windowMs: 60 * 60 * 1000,
  });
  return limiterHolder.__delegateExportLimiter;
}

function backToData(outcome: string): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: `/settings/data?export=${outcome}`, ...NO_STORE },
  });
}

export function exportFileName(workspaceId: string, at: Date): string {
  return `delegate-export-${workspaceId.slice(0, 8)}-${at.toISOString().slice(0, 10)}.json`;
}

export async function handleExportData(request: Request, deps: ExportDeps): Promise<Response> {
  const refused = guardWebMutation(request, "export data");
  if (refused !== null) return refused;
  const guest = await guestFor(request, deps);
  if (guest === null) return backToData("nothing");
  const { app, session } = guest;
  if (!deps.exportLimiter.take(session.userId).ok) return backToData("rate_limited");
  const limits = deps.exportLimits ?? DEFAULT_EXPORT_LIMITS;
  try {
    await withTenant(app.db, session.userId, (tx) =>
      recordAudit(tx, {
        workspaceId: session.workspaceId,
        action: DATA_EXPORTED_ACTION,
        target: `workspace:${session.workspaceId}`,
        decision: "n/a",
        details: { maxBytes: limits.maxBytes },
      }),
    );
  } catch (error: unknown) {
    console.error("export audit failed", error instanceof Error ? error.name : "unknown");
    return apiError(500, "internal", "The export could not be started.");
  }
  const encoder = new TextEncoder();
  const chunks = exportChunks(app, session, limits);
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await chunks.next();
        if (next.done === true) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      } catch (error: unknown) {
        console.error("export stream failed", error instanceof Error ? error.name : "unknown");
        controller.error(new Error("export failed"));
      }
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportFileName(session.workspaceId, new Date(limits.now()))}"`,
      ...NO_STORE,
    },
  });
}
