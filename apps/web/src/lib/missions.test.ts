import { describe, expect, it } from "vitest";

import { MILESTONES } from "./roadmap";
import { MISSION_GROUPS, MISSIONS, missionById, missionsInGroup } from "./missions";

describe("mission catalogue", () => {
  it("lists every mission from the spec exactly once", () => {
    expect(MISSIONS.map((mission) => mission.id)).toEqual([
      "company-xray",
      "automation-audit",
      "build-it",
      "competitive-intel",
      "repo-xray",
      "ship-a-pr",
      "ops-pulse",
      "doc-intelligence",
      "data-analyst",
      "standing-missions",
      "custom-goal",
    ]);
  });

  it("puts every catalogued mission in a known group, each group non-empty", () => {
    for (const group of MISSION_GROUPS) {
      expect(missionsInGroup(group.id).length).toBeGreaterThan(0);
    }
    const grouped = MISSION_GROUPS.flatMap((group) => missionsInGroup(group.id));
    expect(grouped.length).toBe(MISSIONS.filter((mission) => mission.group !== null).length);
  });

  it("only schedules missions in real roadmap milestones", () => {
    const milestoneIds = new Set(MILESTONES.map((milestone) => milestone.id));
    for (const mission of MISSIONS) {
      expect(milestoneIds.has(mission.arrives)).toBe(true);
    }
  });

  it("states duration targets only where the spec sets one", () => {
    const withTargets = MISSIONS.filter((mission) => mission.durationTarget !== null).map(
      (mission) => [mission.id, mission.durationTarget],
    );
    expect(withTargets).toEqual([
      ["company-xray", "< 90 s"],
      ["automation-audit", "< 2.5 min"],
      ["build-it", "< 3 min"],
    ]);
  });

  it("keeps outcomes to one line", () => {
    for (const mission of MISSIONS) {
      expect(mission.outcome.length).toBeLessThanOrEqual(96);
      expect(mission.outcome).not.toMatch(/\n/);
    }
  });

  it("looks missions up by id", () => {
    expect(missionById("repo-xray").name).toBe("Repo X-ray");
  });
});
