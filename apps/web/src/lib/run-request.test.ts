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

  it("starts a run for a GitHub URL instead of a dead end", () => {
    const request = runRequestFor(detect("github.com/vercel/next.js"), {
      companyMission: "automation-audit",
    });
    expect(request.missionId).toBe("custom-goal");
    expect(request.input.goal).toContain("https://github.com/vercel/next.js");
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
