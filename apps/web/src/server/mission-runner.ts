import type { Actor, AwaitShipApproval, RunEvent } from "@delegate/runtime";
import type { FindInstallation, MissionConnections } from "@delegate/runtime/server";

import type { ExecutableMissionId } from "@/lib/m2-contract";

import type { AwaitPlanApproval } from "./plan-approval";
import type { EventDraft } from "./runs";

export interface MissionRunArgs {
  runId: string;
  missionId: ExecutableMissionId;
  input: Record<string, unknown>;
  emit: (draft: EventDraft) => Promise<void>;
  signal: AbortSignal;
  awaitPlanApproval: AwaitPlanApproval;
  awaitShipApproval?: AwaitShipApproval;
  findInstallation?: FindInstallation;
  planApprover: Actor;
  resumeFrom?: readonly RunEvent[];
  connections?: MissionConnections;
  scope?: { workspaceId: string; userId: string };
}

export type { MissionConnections };

export type MissionRunner = (args: MissionRunArgs) => Promise<{ status: "completed" | "failed" }>;
