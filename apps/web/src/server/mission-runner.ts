import type { EventDraft } from "./runs";

export interface MissionRunArgs {
  runId: string;
  missionId: "company-xray";
  input: Record<string, unknown>;
  emit: (draft: EventDraft) => Promise<void>;
  signal: AbortSignal;
}

export type MissionRunner = (args: MissionRunArgs) => Promise<{ status: "completed" | "failed" }>;
