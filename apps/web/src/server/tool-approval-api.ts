import { z } from "zod";

import { type ApiDeps, apiError, guestFor, isSameOrigin, readJson } from "./api";
import { getRunRecord, isTerminalEventType } from "./runs";
import { pendingToolApprovals, recordToolDecision, ToolDecisionError } from "./tool-approval";

const NO_STORE = { "Cache-Control": "no-store" };

export const ToolDecisionRequestSchema = z.discriminatedUnion("decision", [
  z.strictObject({
    approvalId: z.string().min(1).max(64),
    decision: z.literal("approved"),
    argsSha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  z.strictObject({
    approvalId: z.string().min(1).max(64),
    decision: z.literal("rejected"),
    reason: z.string().trim().min(1).max(500).optional(),
  }),
]);

export async function handleListToolApprovals(
  request: Request,
  runId: string,
  deps: ApiDeps,
): Promise<Response> {
  const notFound = () =>
    apiError(404, "not_found", "No run with that id is visible to this session.");
  const guest = await guestFor(request, deps);
  if (guest === null) return notFound();
  const record = await getRunRecord(guest.app, guest.session.userId, runId);
  if (record === null) return notFound();
  const pending = await pendingToolApprovals(guest.app, guest.session.userId, runId);
  return Response.json(
    {
      approvals: pending.map((entry) => ({
        approvalId: entry.runtimeApprovalId,
        tool: entry.tool,
        argsJson: entry.argsJson,
        argsSha256: entry.argsSha256,
      })),
    },
    { headers: NO_STORE },
  );
}

export async function handleToolDecision(
  request: Request,
  runId: string,
  deps: ApiDeps,
): Promise<Response> {
  if (!isSameOrigin(request))
    return apiError(403, "forbidden_origin", "Cross-origin requests cannot approve tool calls.");
  const notFound = () =>
    apiError(404, "not_found", "No run with that id is visible to this session.");
  const guest = await guestFor(request, deps);
  if (guest === null) return notFound();
  const record = await getRunRecord(guest.app, guest.session.userId, runId);
  if (record === null) return notFound();
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const parsed = ToolDecisionRequestSchema.safeParse(body.value);
  if (!parsed.success)
    return apiError(400, "invalid_request", "The tool decision is not valid.", {
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
      ),
    });
  if (record.lastEventType !== null && isTerminalEventType(record.lastEventType))
    return apiError(409, "run_finished", "This run has already finished.");
  const pending = (await pendingToolApprovals(guest.app, guest.session.userId, runId)).find(
    (entry) => entry.runtimeApprovalId === parsed.data.approvalId,
  );
  if (pending === undefined)
    return apiError(409, "no_pending_plan", "No tool call with that id is waiting for approval.");
  if (parsed.data.decision === "approved" && parsed.data.argsSha256 !== pending.argsSha256)
    return apiError(
      409,
      "arguments_changed",
      "The arguments waiting for approval are not the ones you reviewed. Reload and review them again.",
    );
  const actor = { type: "guest" as const, id: guest.session.userId };
  try {
    await recordToolDecision(
      guest.app,
      { runId, workspaceId: record.workspaceId, userId: guest.session.userId },
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
    if (error instanceof ToolDecisionError)
      return error.code === "forbidden"
        ? apiError(403, "forbidden", "Your role cannot decide this tool call.")
        : apiError(409, "no_pending_plan", "This tool call was already decided.");
    throw error;
  }
  return Response.json({ decision: parsed.data.decision }, { headers: NO_STORE });
}
