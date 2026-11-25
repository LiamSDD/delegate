import type { Actor, AwaitShipApproval, RunEvent } from "@delegate/runtime";
import type { FindInstallation } from "@delegate/runtime/server";

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
}

export type MissionRunner = (args: MissionRunArgs) => Promise<{ status: "completed" | "failed" }>;
