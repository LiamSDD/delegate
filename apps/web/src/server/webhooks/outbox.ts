import { enqueueWebhookDeliveries, type TenantTx, withTenant } from "@delegate/db";
import type { RunEvent } from "@delegate/runtime";

import type { AppDatabase } from "../db";
import { kickWebhookDelivery } from "./dispatch";
import { type StoredApproval, storedApproval, storedRun, terminalWebhookType } from "./payload";

interface RunScope {
  runId: string;
  workspaceId: string;
  userId: string;
}

function logFailure(what: string, runId: string, error: unknown): void {
  console.error(what, runId, error instanceof Error ? error.name : "unknown");
}

export async function enqueueRunEventWebhooks(
  tx: TenantTx,
  scope: RunScope,
  event: RunEvent,
): Promise<boolean> {
  const type = terminalWebhookType(event);
  if (type === null) return false;
  const outcome =
    event.type === "run.completed"
      ? { summary: event.payload.summary }
      : event.type === "run.failed"
        ? { error: event.payload.error }
        : {};
  try {
    return await tx.transaction(async (savepoint) => {
      const run = await storedRun(savepoint, scope.runId, outcome);
      if (run === null) return false;
      const enqueued = await enqueueWebhookDeliveries(savepoint, {
        runId: scope.runId,
        eventType: type,
        eventKey: `${scope.runId}:terminal`,
        data: { run },
      });
      return enqueued > 0;
    });
  } catch (error) {
    logFailure("webhook enqueue failed", scope.runId, error);
    return false;
  }
}

export function deliverRunWebhooks(app: AppDatabase, scope: RunScope): void {
  kickWebhookDelivery(app, scope);
}

export async function notifyApprovalRequested(
  app: AppDatabase,
  scope: RunScope,
  approval: StoredApproval,
): Promise<void> {
  try {
    const enqueued = await withTenant(app.db, scope.userId, async (tx) => {
      const run = await storedRun(tx, scope.runId);
      if (run === null) return 0;
      return enqueueWebhookDeliveries(tx, {
        runId: scope.runId,
        eventType: "approval.requested",
        eventKey: `${scope.runId}:approval:${approval.id}`,
        data: { run, approval: storedApproval(approval) },
      });
    });
    if (enqueued > 0) kickWebhookDelivery(app, scope);
  } catch (error) {
    logFailure("approval webhook failed", scope.runId, error);
  }
}
