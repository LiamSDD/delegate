import { ShipAPrInputSchema } from "@delegate/runtime";
import { z } from "zod";

import { SHIP_MISSION_ID } from "@/lib/m2-contract";

import {
  apiError,
  type ApiDeps,
  clientIp,
  guestFor,
  isSameOrigin,
  NO_STORE,
  readCookie,
  readJson,
  retryAfterSeconds,
  runsPausedResponse,
  serializeSessionCookie,
} from "./api";
import { isRunsPausedError } from "./control/pause";
import { executeRun } from "./execute-run";
import { createDbLease } from "./leases";
import { createRunRecord, getRunRecord, isTerminalEventType } from "./runs";
import { resolveGuest, SESSION_COOKIE, signSession } from "./session";
import { pendingShipApproval, recordShipDecision, ShipDecisionError } from "./ship-approval";
import { readRunsPaused } from "./workspace-settings";

const MAX_SHIP_BODY_BYTES = 24 * 1024;

export const ShipRunRequestSchema = z.strictObject({
  ...ShipAPrInputSchema.shape,
  parentRunId: z.uuid().optional(),
});
export type ShipRunRequest = z.infer<typeof ShipRunRequestSchema>;

export const ShipDecisionRequestSchema = z.discriminatedUnion("decision", [
  z.strictObject({ decision: z.literal("approved") }),
  z.strictObject({
    decision: z.literal("rejected"),
    reason: z.string().trim().min(1).max(500).optional(),
  }),
]);

function issues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
}

export async function handleCreateShipRun(request: Request, deps: ApiDeps): Promise<Response> {
  if (!isSameOrigin(request))
    return apiError(403, "forbidden_origin", "Cross-origin requests cannot start runs.");
  if (deps.shipEnabled !== true)
    return apiError(
      503,
      "unavailable",
      "Ship-a-PR is not enabled on this deployment (DELEGATE_SHIP_A_PR=1).",
    );
  const body = await readJson(request, MAX_SHIP_BODY_BYTES);
  if (body instanceof Response) return body;
  const parsed = ShipRunRequestSchema.safeParse(body.value);
  if (!parsed.success)
    return apiError(400, "invalid_request", "The Ship-a-PR request is not valid.", {
      issues: issues(parsed.error),
    });
  const runner = deps.runner();
  if (runner.execution !== "live")
    return apiError(
      503,
      "unavailable",
      "Ship-a-PR needs the live runtime: the simulated dev runner cannot run code in a sandbox.",
    );
  const ipQuota = deps.ipLimiter.take(clientIp(request));
  if (!ipQuota.ok)
    return apiError(429, "rate_limited", "Too many demo runs from this network. Try again later.", {
      headers: { "Retry-After": retryAfterSeconds(ipQuota.retryAfterMs) },
    });

  try {
    const app = await deps.app();
    const secret = deps.secret();
    const { session, issued } = await resolveGuest(
      app,
      readCookie(request, SESSION_COOKIE),
      secret,
    );
    const cookieHeaders: Record<string, string> = issued
      ? { "Set-Cookie": serializeSessionCookie(signSession(session, secret), deps.production) }
      : {};
    if ((await readRunsPaused(app, session)) !== null) return runsPausedResponse(cookieHeaders);
    const quota = deps.guestLimiter.take(session.userId);
    if (!quota.ok)
      return apiError(429, "rate_limited", "Demo runs are limited per hour. Try again later.", {
        headers: { "Retry-After": retryAfterSeconds(quota.retryAfterMs), ...cookieHeaders },
      });
    const { parentRunId: requestedParent, ...shipInput } = parsed.data;
    const parentRunId =
      requestedParent === undefined
        ? undefined
        : (await getRunRecord(app, session.userId, requestedParent))?.id;
    if (requestedParent !== undefined && parentRunId === undefined)
      return apiError(400, "invalid_request", "The parent run is not visible to this session.", {
        headers: cookieHeaders,
      });
    const input: Record<string, unknown> = {
      repoUrl: shipInput.repoUrl,
      improvement: shipInput.improvement,
      ...(shipInput.ref === undefined ? {} : { ref: shipInput.ref }),
      ...(parentRunId === undefined ? {} : { parentRunId }),
    };
    const { runId } = await createRunRecord(app, session, {
      missionId: SHIP_MISSION_ID,
      input,
      execution: runner.execution,
      ...(parentRunId === undefined ? {} : { parentRunId }),
    });
    const ctx = { runId, workspaceId: session.workspaceId, userId: session.userId };
    deps.schedule(() =>
      executeRun({
        app,
        ctx,
        missionId: SHIP_MISSION_ID,
        input,
        runner: runner.run,
        registry: deps.registry,
        autoApprovePlan: true,
        lease: createDbLease(app, ctx),
        ...(deps.shipInstallations === undefined
          ? {}
          : { findInstallation: deps.shipInstallations(session.workspaceId, session.userId) }),
      }),
    );
    return Response.json({ runId }, { status: 201, headers: { ...NO_STORE, ...cookieHeaders } });
  } catch (error: unknown) {
    if (isRunsPausedError(error)) return runsPausedResponse();
    console.error("create ship run failed", error instanceof Error ? error.message : "unknown");
    return apiError(500, "internal", "The run could not be created.");
  }
}

export async function handleShipDecision(
  request: Request,
  runId: string,
  deps: ApiDeps,
): Promise<Response> {
  if (!isSameOrigin(request))
    return apiError(403, "forbidden_origin", "Cross-origin requests cannot approve shipping.");
  const guest = await guestFor(request, deps);
  const notFound = () =>
    apiError(404, "not_found", "No run with that id is visible to this session.");
  if (guest === null) return notFound();
  const record = await getRunRecord(guest.app, guest.session.userId, runId);
  if (record === null) return notFound();
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const parsed = ShipDecisionRequestSchema.safeParse(body.value);
  if (!parsed.success)
    return apiError(400, "invalid_request", "The ship decision is not valid.", {
      issues: issues(parsed.error),
    });
  if (record.lastEventType !== null && isTerminalEventType(record.lastEventType))
    return apiError(409, "run_finished", "This run has already finished.");
  const pending = await pendingShipApproval(guest.app, guest.session.userId, runId);
  if (pending === null)
    return apiError(409, "no_pending_ship", "This run has nothing waiting for ship approval.");
  const actor = { type: "guest" as const, id: guest.session.userId };
  const ctx = { runId, workspaceId: record.workspaceId, userId: guest.session.userId };
  try {
    await recordShipDecision(
      guest.app,
      ctx,
      pending.approvalId,
      parsed.data.decision === "approved"
        ? { decision: "approved", actor }
        : {
            decision: "rejected",
            actor,
            ...(parsed.data.reason === undefined ? {} : { reason: parsed.data.reason }),
          },
    );
  } catch (error: unknown) {
    if (error instanceof ShipDecisionError)
      return error.code === "forbidden"
        ? apiError(403, "forbidden", "Your role cannot approve shipping.")
        : apiError(409, "no_pending_ship", "This change was already decided.");
    console.error("ship decision failed", error instanceof Error ? error.message : "unknown");
    return apiError(500, "internal", "The decision could not be recorded.");
  }
  return Response.json(
    { decision: parsed.data.decision, mode: pending.mode },
    { headers: NO_STORE },
  );
}
