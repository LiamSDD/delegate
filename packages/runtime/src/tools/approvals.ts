import { createHash } from "node:crypto";

import { type Actor } from "../events";

export const TOOL_APPROVAL_ARGS_MAX_BYTES = 32_768;

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, sortKeys(entry)]),
    );
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value ?? {}));
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface ToolBinding {
  connectorId: string;
  definitionSha256: string;
}

export interface ToolPreapproval extends ToolBinding {
  tool: string;
}

export interface ToolApprovalRequest {
  approvalId: string;
  toolCallId: string;
  stepId: string;
  tool: string;
  capability: string;
  argsSummary: string;
  argsJson: string;
  argsSha256: string;
  binding?: ToolBinding;
  policyId: string;
  reason: string;
}

export type ToolApprovalResolution =
  | { resolution: "approved"; resolvedBy: Actor; note?: string }
  | { resolution: "rejected"; resolvedBy: Actor; note?: string };

export interface ToolApprovalGate {
  decide(request: ToolApprovalRequest): Promise<ToolApprovalResolution>;
}

export const PREAPPROVABLE_TOOL_PREFIX = "mcp__";

export const WORKSPACE_PREAPPROVAL_ACTOR: Actor = { type: "system", id: "workspace-preapproval" };

export function createPreapprovalGate(
  preapprovals: readonly ToolPreapproval[],
  fallback?: ToolApprovalGate,
): ToolApprovalGate {
  const matches = (request: ToolApprovalRequest) =>
    request.tool.startsWith(PREAPPROVABLE_TOOL_PREFIX) &&
    request.binding !== undefined &&
    preapprovals.some(
      (entry) =>
        entry.tool === request.tool &&
        entry.connectorId === request.binding?.connectorId &&
        entry.definitionSha256 === request.binding.definitionSha256,
    );
  return {
    decide(request) {
      if (matches(request)) {
        return Promise.resolve({
          resolution: "approved",
          resolvedBy: WORKSPACE_PREAPPROVAL_ACTOR,
          note: "Pre-approved for automatic use in workspace settings",
        });
      }
      if (fallback !== undefined) return fallback.decide(request);
      return Promise.resolve({
        resolution: "rejected",
        resolvedBy: { type: "system", id: "no-approver" },
        note: "Not pre-approved and no human approver is available for this run",
      });
    },
  };
}
