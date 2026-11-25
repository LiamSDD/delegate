import type { Actor, RunEvent } from "@delegate/runtime";

import type { RunnableMissionId } from "@/lib/m2-contract";

import type { AwaitPlanApproval } from "./plan-approval";
import type { EventDraft } from "./runs";

export interface MissionRunArgs {
  runId: string;
  missionId: RunnableMissionId;
  input: Record<string, unknown>;
  emit: (draft: EventDraft) => Promise<void>;
  signal: AbortSignal;
  awaitPlanApproval: AwaitPlanApproval;
  planApprover: Actor;
  resumeFrom?: readonly RunEvent[];
  scope?: { workspaceId: string; userId: string };
}

export type MissionRunner = (args: MissionRunArgs) => Promise<{ status: "completed" | "failed" }>;
