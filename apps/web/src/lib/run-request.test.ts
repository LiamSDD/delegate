import { describe, expect, it } from "vitest";

import { detectMission } from "./detect-mission";
import { runLabelFor, runRequestFor } from "./run-request";
import { runTarget } from "./runs/target";

function detect(text: string) {
  const detected = detectMission(text);
  if (detected === null) throw new Error("nothing detected");
  return detected;
}

describe("runRequestFor", () => {
  it("turns free text into a live custom-goal run", () => {
    const detected = detect("  I want to achieve nike's marketing and agentic work ");
    expect(detected.kind).toBe("goal");
    expect(runRequestFor(detected, { companyMission: "automation-audit" })).toEqual({
      missionId: "custom-goal",
      input: { goal: "I want to achieve nike's marketing and agentic work" },
    });
    expect(runLabelFor(detected, { companyMission: "automation-audit" })).toBe("Run goal");
  });

  it("keeps company URLs on the chosen company mission with an optional department", () => {
    const detected = detect("stripe.com");
    expect(
      runRequestFor(detected, { companyMission: "automation-audit", department: " Support " }),
    ).toEqual({
      missionId: "automation-audit",
      input: { url: "https://stripe.com", department: "Support" },
    });
    expect(runRequestFor(detected, { companyMission: "company-xray", department: "x" })).toEqual({
      missionId: "company-xray",
      input: { url: "https://stripe.com" },
    });
    expect(runLabelFor(detected, { companyMission: "company-xray" })).toBe("Run X-ray");
  });

  it("routes GitHub URLs to Repo X-ray, keeping a tree ref from the raw input", () => {
    const raw = "https://github.com/vercel/next.js/tree/canary";
    const detected = detect(raw);
    expect(runRequestFor(detected, { companyMission: "automation-audit", rawInput: raw })).toEqual({
      missionId: "repo-xray",
      input: { url: raw },
    });
    expect(runRequestFor(detected, { companyMission: "automation-audit" })).toEqual({
      missionId: "repo-xray",
      input: { url: "https://github.com/vercel/next.js" },
    });
    expect(runLabelFor(detected, { companyMission: "automation-audit" })).toBe("Run Repo X-ray");
  });

  it("caps very long goals at the runtime limit", () => {
    const request = runRequestFor(detect(`grow ${"a".repeat(1500)}`), {
      companyMission: "automation-audit",
    });
    expect(request.input.goal?.length).toBe(900);
  });
});

describe("runTarget", () => {
  it("labels runs by host, else by a shortened goal", () => {
    expect(runTarget({ url: "https://www.acme.com/" })).toBe("acme.com");
    expect(runTarget({ goal: "Cut  support\nbacklog" })).toBe("Cut support backlog");
    expect(runTarget({ goal: "x".repeat(80) })).toHaveLength(60);
    expect(runTarget({})).toBeNull();
  });
});
