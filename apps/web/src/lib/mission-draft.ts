import { detectMission, type DetectedMission, MAX_INPUT_LENGTH } from "./detect-mission";
import { type Mission, missionById } from "./missions";
import { MILESTONES, type MilestoneId } from "./roadmap";

export interface MissionDraft {
  input: string;
  truncated: boolean;
  detected: DetectedMission;
  missions: readonly Mission[];
  firstArrival: MilestoneId;
  fullArrival: MilestoneId;
}

function milestoneIndex(id: MilestoneId): number {
  return MILESTONES.findIndex((milestone) => milestone.id === id);
}

export function draftFromQuery(value: string | readonly string[] | undefined): MissionDraft | null {
  const first = typeof value === "string" ? value : value?.[0];
  if (first === undefined) return null;
  const trimmed = first.trim();
  const input = trimmed.slice(0, MAX_INPUT_LENGTH);
  const detected = detectMission(input);
  if (detected === null) return null;

  const missions = detected.missionIds.map((id) => missionById(id));
  const arrivals = missions
    .map((mission) => mission.arrives)
    .sort((a, b) => milestoneIndex(a) - milestoneIndex(b));
  const firstArrival = arrivals[0];
  const fullArrival = arrivals.at(-1);
  if (firstArrival === undefined || fullArrival === undefined) return null;

  return {
    input,
    truncated: trimmed.length > MAX_INPUT_LENGTH,
    detected,
    missions,
    firstArrival,
    fullArrival,
  };
}
