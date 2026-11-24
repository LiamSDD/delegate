import { type MilestoneId } from "./roadmap";

export type MissionId =
  | "company-xray"
  | "automation-audit"
  | "build-it"
  | "competitive-intel"
  | "repo-xray"
  | "ship-a-pr"
  | "ops-pulse"
  | "doc-intelligence"
  | "data-analyst"
  | "standing-missions"
  | "custom-goal";

export type MissionGroupId = "public-signal" | "engineering" | "internal" | "standing";

export interface MissionGroup {
  id: MissionGroupId;
  code: string;
  name: string;
  setup: string;
}

export interface Mission {
  id: MissionId;
  group: MissionGroupId | null;
  name: string;
  outcome: string;
  inputs: string;
  durationTarget: string | null;
  arrives: MilestoneId;
  hero: boolean;
}

export const MISSION_GROUPS: readonly MissionGroup[] = [
  { id: "public-signal", code: "A", name: "Public signal", setup: "Zero setup" },
  { id: "engineering", code: "B", name: "Engineering", setup: "Public or connected repos" },
  { id: "internal", code: "C", name: "Internal", setup: "MCP connectors or uploads" },
  { id: "standing", code: "D", name: "Standing", setup: "Any mission, on a trigger" },
];

export const MISSIONS: readonly Mission[] = [
  {
    id: "company-xray",
    group: "public-signal",
    name: "Company X-ray",
    outcome: "Cited brief: offering, customers, market, five competitors, SWOT, stack signals.",
    inputs: "Company URL",
    durationTarget: "< 90 s",
    arrives: "M1",
    hero: true,
  },
  {
    id: "automation-audit",
    group: "public-signal",
    name: "AI Automation Audit",
    outcome: "5–8 ranked workflows to automate, each with an explicit, adjustable ROI model.",
    inputs: "Company URL, optional department",
    durationTarget: "< 2.5 min",
    arrives: "M2",
    hero: true,
  },
  {
    id: "build-it",
    group: "public-signal",
    name: "Build it",
    outcome: "Turns an audit item into a live, cited assistant trained on the company's site.",
    inputs: "An Automation Audit item",
    durationTarget: "< 3 min",
    arrives: "M3",
    hero: true,
  },
  {
    id: "competitive-intel",
    group: "public-signal",
    name: "Competitive Intel",
    outcome: "Feature, pricing and positioning matrix, plus a weekly monitor of semantic diffs.",
    inputs: "Company URL, competitors",
    durationTarget: null,
    arrives: "M7",
    hero: false,
  },
  {
    id: "repo-xray",
    group: "engineering",
    name: "Repo X-ray",
    outcome: "Architecture map, risk hotspots, test gaps and ranked high-leverage improvements.",
    inputs: "Public GitHub URL",
    durationTarget: null,
    arrives: "M5",
    hero: true,
  },
  {
    id: "ship-a-pr",
    group: "engineering",
    name: "Ship-a-PR",
    outcome: "Implements one improvement in a sandbox, runs the tests, opens a PR after approval.",
    inputs: "Repo X-ray item, authorised repo",
    durationTarget: null,
    arrives: "M5",
    hero: true,
  },
  {
    id: "ops-pulse",
    group: "internal",
    name: "Ops Pulse",
    outcome: "Weekly cross-tool brief of blockers, stale work and decisions, each line cited.",
    inputs: "Slack, Jira/Linear, GitHub, Drive or Notion",
    durationTarget: null,
    arrives: "M6",
    hero: false,
  },
  {
    id: "doc-intelligence",
    group: "internal",
    name: "Doc Intelligence",
    outcome: "Cited Q&A, contradictions report and RFP or security-questionnaire drafts.",
    inputs: "PDF/DOCX uploads or connected drives",
    durationTarget: null,
    arrives: "M7",
    hero: false,
  },
  {
    id: "data-analyst",
    group: "internal",
    name: "Data Analyst",
    outcome: "Charts and insights from sandboxed code, returned with the exact re-runnable code.",
    inputs: "CSV/XLSX upload or warehouse connector",
    durationTarget: null,
    arrives: "M7",
    hero: false,
  },
  {
    id: "standing-missions",
    group: "standing",
    name: "Standing missions",
    outcome: "Any mission on a trigger; results land in the approval queue or a channel.",
    inputs: "Cron, signed webhook, Slack mention, new file",
    durationTarget: null,
    arrives: "M7",
    hero: false,
  },
  {
    id: "custom-goal",
    group: null,
    name: "Custom goal",
    outcome: "Free text; the planner composes the tools and agents.",
    inputs: "A goal in plain language",
    durationTarget: null,
    arrives: "M2",
    hero: false,
  },
];

export function missionsInGroup(group: MissionGroupId): readonly Mission[] {
  return MISSIONS.filter((mission) => mission.group === group);
}

export function missionById(id: MissionId): Mission {
  const mission = MISSIONS.find((candidate) => candidate.id === id);
  if (mission === undefined) throw new Error(`Unknown mission ${id}`);
  return mission;
}
