import { type ClaimedWebhookDelivery, runs, runTotalsSchema, type TenantTx } from "@delegate/db";
import {
  API_VERSION,
  CANCELLED_ERROR_CODE,
  WEBHOOK_TEST_EVENT_TYPE,
  WebhookApprovalSchema,
  type WebhookEventType,
  WebhookEventSchema,
  WebhookRunSchema,
} from "@delegate/sdk/contract";
import type { RunEvent } from "@delegate/runtime";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { runTarget } from "@/lib/runs/target";

export const WEBHOOK_SUMMARY_MAX_CHARS = 2_000;
export const WEBHOOK_ERROR_MESSAGE_MAX_CHARS = 500;
export const WEBHOOK_APPROVAL_SUMMARY_MAX_CHARS = 300;

export const StoredRunSchema = WebhookRunSchema.omit({ url: true });
export type StoredRun = z.infer<typeof StoredRunSchema>;

export const StoredApprovalSchema = WebhookApprovalSchema.omit({ url: true });
export type StoredApproval = z.infer<typeof StoredApprovalSchema>;

const StoredRunDataSchema = z.object({
  run: StoredRunSchema,
  approval: StoredApprovalSchema.optional(),
});
const StoredTestDataSchema = z.object({ message: z.string() });

function capped(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function terminalWebhookType(
  event: RunEvent,
): Extract<WebhookEventType, "run.completed" | "run.failed" | "run.cancelled"> | null {
  if (event.type === "run.completed") return "run.completed";
  if (event.type !== "run.failed") return null;
  return event.payload.error.code === CANCELLED_ERROR_CODE ? "run.cancelled" : "run.failed";
}

export async function storedRun(
  tx: TenantTx,
  runId: string,
  outcome: { summary?: string; error?: { code: string; message: string } } = {},
): Promise<StoredRun | null> {
  const [row] = await tx
    .select({
      id: runs.id,
      mission: runs.mission,
      input: runs.input,
      status: runs.status,
      totals: runs.totals,
      createdAt: runs.createdAt,
      startedAt: runs.startedAt,
      finishedAt: runs.finishedAt,
    })
    .from(runs)
    .where(eq(runs.id, runId));
  if (row === undefined) return null;
  const input = z.record(z.string(), z.unknown()).safeParse(row.input);
  const totals = runTotalsSchema.parse(row.totals);
  return {
    id: row.id,
    mission: row.mission,
    target: input.success ? runTarget(input.data) : null,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    summary:
      outcome.summary === undefined ? null : capped(outcome.summary, WEBHOOK_SUMMARY_MAX_CHARS),
    error:
      outcome.error === undefined
        ? null
        : {
            code: outcome.error.code,
            message: capped(outcome.error.message, WEBHOOK_ERROR_MESSAGE_MAX_CHARS),
          },
    totals: {
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      costMicroUsd: totals.costMicroUsd,
    },
  };
}

export function storedApproval(approval: StoredApproval): StoredApproval {
  return {
    id: approval.id,
    kind: approval.kind,
    summary: capped(approval.summary, WEBHOOK_APPROVAL_SUMMARY_MAX_CHARS),
  };
}

export function renderWebhookBody(
  delivery: Pick<
    ClaimedWebhookDelivery,
    "deliveryId" | "eventType" | "createdAt" | "data" | "origin"
  >,
): string {
  const envelope = {
    id: delivery.deliveryId,
    type: delivery.eventType,
    created: delivery.createdAt.toISOString(),
    apiVersion: API_VERSION,
  };
  if (delivery.eventType === WEBHOOK_TEST_EVENT_TYPE)
    return JSON.stringify(
      WebhookEventSchema.parse({ ...envelope, data: StoredTestDataSchema.parse(delivery.data) }),
    );
  const stored = StoredRunDataSchema.parse(delivery.data);
  const url = `${delivery.origin}/runs/${stored.run.id}`;
  return JSON.stringify(
    WebhookEventSchema.parse({
      ...envelope,
      data: {
        run: { ...stored.run, url },
        ...(stored.approval === undefined ? {} : { approval: { ...stored.approval, url } }),
      },
    }),
  );
}
