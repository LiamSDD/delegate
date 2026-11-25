import { type Actor } from "../events";

export interface ToolApprovalRequest {
  approvalId: string;
  toolCallId: string;
  stepId: string;
  tool: string;
  capability: string;
  argsSummary: string;
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
  preapprovedTools: readonly string[],
  fallback?: ToolApprovalGate,
): ToolApprovalGate {
  const allowed = new Set(preapprovedTools);
  return {
    decide(request) {
      if (request.tool.startsWith(PREAPPROVABLE_TOOL_PREFIX) && allowed.has(request.tool)) {
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
