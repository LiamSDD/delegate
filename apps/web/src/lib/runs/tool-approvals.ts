import type { RunEvent } from "@delegate/runtime";

export interface PendingToolCall {
  approvalId: string;
  tool: string;
  server: string | null;
  action: string;
  args: string;
  reason: string;
  seq: number;
}

const CONNECTOR_TOOL = /^mcp__([a-z0-9][a-z0-9-]{0,31})__(.+)$/;

export function describeToolCall(
  summary: string,
): Omit<PendingToolCall, "approvalId" | "reason" | "seq"> {
  const split = summary.indexOf(": ");
  const tool = split === -1 ? summary : summary.slice(0, split);
  const rest = split === -1 ? "" : summary.slice(split + 2);
  const match = CONNECTOR_TOOL.exec(tool);
  if (match === null) return { tool, server: null, action: tool, args: rest };
  const server = match[1] ?? null;
  const action = match[2] ?? tool;
  const prefix = `${server ?? ""}.${action} `;
  return { tool, server, action, args: rest.startsWith(prefix) ? rest.slice(prefix.length) : rest };
}

export function pendingToolCalls(events: readonly RunEvent[]): PendingToolCall[] {
  const pending = new Map<string, PendingToolCall>();
  for (const event of events) {
    if (event.type === "approval.resolved") pending.delete(event.payload.approvalId);
    if (event.type !== "approval.requested" || event.payload.toolCallId === undefined) continue;
    pending.set(event.payload.approvalId, {
      approvalId: event.payload.approvalId,
      reason: event.payload.reason,
      seq: event.seq,
      ...describeToolCall(event.payload.summary),
    });
  }
  return [...pending.values()];
}
