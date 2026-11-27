import {
  BackendError,
  type DelegateBackend,
  handleMcpHttpRequest,
  mcpMethodNotAllowed,
  mcpUnauthorized,
} from "@delegate/mcp-server";
import { MISSIONS } from "@delegate/runtime";

import { RUNNABLE_MISSION_IDS } from "@/lib/m2-contract";

import {
  type ApiDeps,
  clientIp,
  CreateRunRequestSchema,
  runSummary,
  startRunForSession,
} from "./api";
import { authenticateBearer, type TokenSession } from "./api-tokens";
import { createRateLimiter, type RateLimiter } from "./session";
import type { AppDatabase } from "./db";
import { reviveOrSweep, wakeRun } from "./durable";
import { pendingPlanApproval, PlanDecisionError, recordPlanDecision } from "./plan-approval";
import { buildRunView } from "./run-view-api";
import { artifactContent, getRunRecord, isTerminalEventType, listRuns } from "./runs";

export const MCP_MISSIONS = RUNNABLE_MISSION_IDS.map((id) => ({
  id,
  title: MISSIONS[id].title,
  description: MISSIONS[id].description,
}));

export function siteOrigin(request: Request): string {
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const url = new URL(request.url);
  if (forwardedHost !== undefined && forwardedHost !== "")
    return `${forwardedProto === "http" ? "http" : "https"}://${forwardedHost}`;
  return url.origin;
}

export const MCP_REQUESTS_PER_HOUR = 1_200;

const limiterHolder = globalThis as typeof globalThis & { __delegateMcpLimiter?: RateLimiter };

export function mcpRequestLimiter(): RateLimiter {
  limiterHolder.__delegateMcpLimiter ??= createRateLimiter({
    limit: MCP_REQUESTS_PER_HOUR,
    windowMs: 60 * 60 * 1000,
  });
  return limiterHolder.__delegateMcpLimiter;
}

export function inProcessBackend(
  app: AppDatabase,
  session: TokenSession,
  deps: ApiDeps,
  origin: string,
  ip: string,
): DelegateBackend {
  const runUrl = (runId: string) => `${origin}/runs/${runId}`;
  const record = async (runId: string) => {
    const found = await getRunRecord(app, session.userId, runId);
    if (found?.workspaceId !== session.workspaceId) return null;
    return reviveOrSweep(app, session.userId, found, deps);
  };
  const start = async (request: unknown) => {
    const parsed = CreateRunRequestSchema.safeParse(request);
    if (!parsed.success)
      throw new BackendError(
        `The mission request is not valid: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ")}`,
      );
    const ipQuota = deps.ipLimiter.take(ip);
    if (!ipQuota.ok) throw new BackendError("Too many runs from this network. Try again later.");
    const started = await startRunForSession(app, session, parsed.data, deps, {
      autoApprovePlan: false,
    });
    if (!started.ok) {
      const body = (await started.response.json()) as { error?: { message?: string } };
      throw new BackendError(body.error?.message ?? "The run could not be started.");
    }
    return { runId: started.runId, webUrl: runUrl(started.runId) };
  };
  return {
    runUrl,
    startMission: (request) => start(request),
    startAutopilot: (request) => start({ missionId: "autopilot", input: request }),
    async getRun(runId) {
      const found = await record(runId);
      return found === null ? null : buildRunView(app, session.userId, found);
    },
    async listRuns(limit) {
      const rows = await listRuns(app, session, Math.min(50, Math.max(1, limit)));
      return rows.map((row) => ({
        id: row.id,
        mission: row.mission,
        target: row.target,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        finishedAt: row.finishedAt?.toISOString() ?? null,
      }));
    },
    async decidePlan(runId, decision) {
      const found = await record(runId);
      if (found === null) throw new BackendError("No run with that id is visible to this token.");
      if (found.lastEventType !== null && isTerminalEventType(found.lastEventType))
        throw new BackendError(`This run has already finished (${runSummary(found).status}).`);
      const pending = await pendingPlanApproval(app, session.userId, runId);
      if (pending === null) throw new BackendError("This run has no plan waiting for approval.");
      try {
        await recordPlanDecision(
          app,
          { runId, workspaceId: found.workspaceId, userId: session.userId },
          pending.approvalId,
          decision.decision === "approved"
            ? { decision: "approved" }
            : decision.reason === undefined
              ? { decision: "rejected" }
              : { decision: "rejected", reason: decision.reason },
        );
      } catch (error) {
        if (error instanceof PlanDecisionError)
          throw new BackendError(
            error.code === "forbidden"
              ? "This token's user cannot decide this plan."
              : "This plan was already decided.",
          );
        throw error;
      }
      deps.schedule(() => wakeRun(app, session.userId, runId, deps));
      return { decision: decision.decision };
    },
    async getArtifact(runId, artifactId) {
      if ((await record(runId)) === null) return null;
      const artifact = await artifactContent(app, session.userId, runId, artifactId.slice(0, 200));
      return artifact;
    },
  };
}

export async function handleMcp(
  request: Request,
  deps: ApiDeps,
  limiter: RateLimiter = mcpRequestLimiter(),
): Promise<Response> {
  if (request.method !== "POST") return mcpMethodNotAllowed();
  const app = await deps.app();
  const session = await authenticateBearer(app, request);
  if (session === null) return mcpUnauthorized();
  const quota = limiter.take(session.tokenId);
  if (!quota.ok)
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32000, message: "Rate limited" }, id: null },
      { status: 429, headers: { "Retry-After": String(Math.ceil(quota.retryAfterMs / 1000)) } },
    );
  try {
    return await handleMcpHttpRequest(
      request,
      inProcessBackend(app, session, deps, siteOrigin(request), clientIp(request)),
      { missions: MCP_MISSIONS },
    );
  } catch (error) {
    console.error("mcp request failed", error instanceof Error ? error.name : "unknown");
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null },
      { status: 500 },
    );
  }
}
