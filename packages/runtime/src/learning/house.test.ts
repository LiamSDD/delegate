import { describe, expect, it } from "vitest";

import {
  housePlaybookFileName,
  housePlaybookKeyOfFile,
  housePlaybookKeys,
  parseHousePlaybook,
} from "./house";
import { GOAL_CATEGORIES } from "./lessons";
import { emptyPlaybook } from "./playbook";

const at = "2026-11-25T10:00:00.000Z";
const MISSION_IDS = [
  "company-xray",
  "automation-audit",
  "build-agent",
  "repo-xray",
  "custom-goal",
  "ship-a-pr",
];

describe("house playbook files", () => {
  it("names one file per mission and one per goal category, and maps the name back", () => {
    for (const missionId of MISSION_IDS) {
      const file = housePlaybookFileName(missionId);
      expect(file).toBe(`${missionId}.house.json`);
      expect(housePlaybookKeyOfFile(file)).toBe(missionId);
    }
    for (const category of [...Object.keys(GOAL_CATEGORIES), "general"]) {
      const key = `custom-goal:${category}`;
      expect(housePlaybookFileName(key)).toBe(`custom-goal.${category}.house.json`);
      expect(housePlaybookKeyOfFile(`custom-goal.${category}.house.json`)).toBe(key);
    }
  });

  it("refuses a key or a file name that could leave the playbooks directory", () => {
    expect(() => housePlaybookFileName("../secrets")).toThrow();
    expect(() => housePlaybookFileName("a:b:c")).toThrow();
    expect(housePlaybookKeyOfFile("notes.json")).toBeUndefined();
    expect(housePlaybookKeyOfFile("a.b.c.house.json")).toBeUndefined();
    expect(housePlaybookKeyOfFile("../x.house.json")).toBeUndefined();
  });

  it("loads a house file only for its own key and scope", () => {
    const house = { ...emptyPlaybook("repo-xray", "house", at), version: 3 };
    const raw = JSON.stringify(house);
    expect(parseHousePlaybook("repo-xray", raw)).toEqual(house);
    expect(parseHousePlaybook("company-xray", raw)).toBeNull();
    expect(
      parseHousePlaybook("repo-xray", JSON.stringify({ ...house, scope: "workspace" })),
    ).toBeNull();
    expect(parseHousePlaybook("repo-xray", "{not json")).toBeNull();
    expect(parseHousePlaybook("repo-xray", JSON.stringify({ ...house, extra: 1 }))).toBeNull();
  });

  it("derives the keys a mission's inputs resolve to, with goal categories", () => {
    expect(housePlaybookKeys("company-xray", [{ url: "https://a.example" }])).toEqual([
      "company-xray",
    ]);
    expect(
      housePlaybookKeys("custom-goal", [
        { goal: "Find our three closest competitors" },
        { goal: "Grow sales in Europe" },
        { goal: "Compare us with a rival" },
        { goal: "Something else entirely" },
      ]),
    ).toEqual(["custom-goal:competitors", "custom-goal:general", "custom-goal:growth"]);
  });
});
