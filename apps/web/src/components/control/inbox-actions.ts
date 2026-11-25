import type { InboxItem } from "@/server/control/inbox";

export type InboxDecision = "approved" | "rejected";

export type InboxAction =
  | { via: "request"; url: string; body: Record<string, unknown> }
  | { via: "run_page"; href: string; why: string };

export const SHIP_NEEDS_THE_DIFF =
  "Approving ships the exact diff, and only the run page shows it in full.";
export const EXPIRED_NEEDS_THE_RUN =
  "This request is past its deadline. Open the run to see what happened to it.";

export function runHref(runId: string): string {
  return `/runs/${runId}`;
}

export function inboxAction(
  item: InboxItem,
  decision: InboxDecision,
  reason?: string,
): InboxAction {
  if (item.expired)
    return { via: "run_page", href: runHref(item.runId), why: EXPIRED_NEEDS_THE_RUN };
  const note = reason?.trim();
  const rejection = note === undefined || note === "" ? {} : { reason: note };
  switch (item.kind) {
    case "plan":
      return {
        via: "request",
        url: `/api/runs/${item.runId}/plan`,
        body:
          decision === "approved" ? { decision, steps: item.steps } : { decision, ...rejection },
      };
    case "ship":
      if (decision === "approved")
        return { via: "run_page", href: runHref(item.runId), why: SHIP_NEEDS_THE_DIFF };
      return {
        via: "request",
        url: `/api/runs/${item.runId}/ship`,
        body: { decision, ...rejection },
      };
    case "tool":
      return {
        via: "request",
        url: `/api/runs/${item.runId}/tool-approval`,
        body:
          decision === "approved"
            ? { approvalId: item.approvalId, decision, argsSha256: item.argsSha256 }
            : { approvalId: item.approvalId, decision, ...rejection },
      };
  }
}
