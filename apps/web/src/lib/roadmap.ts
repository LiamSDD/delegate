export type MilestoneId = "M0" | "M1" | "M2" | "M3" | "M4" | "M5" | "M6" | "M7" | "M8";

export interface Milestone {
  id: MilestoneId;
  title: string;
}

export const MILESTONES: readonly Milestone[] = [
  { id: "M0", title: "Foundation" },
  { id: "M1", title: "Agent runtime + Company X-ray" },
  { id: "M2", title: "Multi-agent + Automation Audit" },
  { id: "M3", title: "Build-it, durability, human-in-the-loop" },
  { id: "M4", title: "Trust layer" },
  { id: "M5", title: "Engineering missions" },
  { id: "M6", title: "Platform interfaces" },
  { id: "M7", title: "Enterprise" },
  { id: "M8", title: "Launch polish" },
];

export const CURRENT_MILESTONE: MilestoneId = "M3";

export function milestoneById(id: MilestoneId): Milestone {
  const milestone = MILESTONES.find((candidate) => candidate.id === id);
  if (milestone === undefined) throw new Error(`Unknown milestone ${id}`);
  return milestone;
}

export function isShipped(id: MilestoneId): boolean {
  const index = MILESTONES.findIndex((milestone) => milestone.id === id);
  const current = MILESTONES.findIndex((milestone) => milestone.id === CURRENT_MILESTONE);
  return index <= current;
}
