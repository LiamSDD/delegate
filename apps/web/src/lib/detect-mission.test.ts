import { describe, expect, it } from "vitest";

import { awaitsRepo, detectMission } from "./detect-mission";

describe("detectMission", () => {
  it("returns null for empty or whitespace input", () => {
    expect(detectMission("")).toBeNull();
    expect(detectMission("   \n ")).toBeNull();
  });

  it.each([
    ["stripe.com", "stripe.com", "https://stripe.com"],
    ["https://www.Linear.app/", "linear.app", "https://www.linear.app"],
    ["http://datadoghq.com/pricing", "datadoghq.com", "http://datadoghq.com/pricing"],
    ["  shop.example.co.uk  ", "shop.example.co.uk", "https://shop.example.co.uk"],
  ])("detects %s as a company URL", (input, target, url) => {
    const detected = detectMission(input);
    expect(detected).toEqual({
      kind: "company",
      label: "Company X-ray + AI Automation Audit",
      missionIds: ["company-xray", "automation-audit"],
      target,
      url,
    });
  });

  it.each([
    ["github.com/vercel/next.js", "vercel/next.js"],
    ["https://github.com/LiamSDD/delegate.git", "LiamSDD/delegate"],
    ["https://www.github.com/facebook/react/tree/main/packages", "facebook/react"],
    ["github.com/owner/repo?tab=readme", "owner/repo"],
  ])("detects %s as a repo", (input, target) => {
    expect(detectMission(input)).toEqual({
      kind: "repo",
      label: "Repo X-ray",
      missionIds: ["repo-xray"],
      target,
      url: `https://github.com/${target}`,
    });
  });

  it.each([
    "github.co",
    "github.com",
    "https://github.com/",
    "www.github.com",
    "github.com/sindresorhus",
    "github.com/sindresorhus/",
    "https://github.com/vercel",
  ])("waits for owner/repo on %s instead of offering a company audit", (input) => {
    expect(detectMission(input)).toBeNull();
    expect(awaitsRepo(input)).toBe(true);
  });

  it("only waits for a repo on GitHub addresses", () => {
    expect(awaitsRepo("")).toBe(false);
    expect(awaitsRepo("stripe.com")).toBe(false);
    expect(awaitsRepo("github.com/vercel/next.js")).toBe(false);
    expect(awaitsRepo("github.com/features")).toBe(false);
    expect(awaitsRepo("find repos on github.com")).toBe(false);
  });

  it("never offers the company audit while a repo address is typed", () => {
    const typed = "github.com/sindresorhus/ky";
    for (let length = "github.c".length; length <= typed.length; length += 1)
      expect(detectMission(typed.slice(0, length))?.kind, typed.slice(0, length)).not.toBe(
        "company",
      );
  });

  it.each(["github.com/features", "github.com/features/actions", "github.com/-bad/repo"])(
    "treats %s as GitHub the company, not a repo",
    (input) => {
      expect(detectMission(input)?.kind).toBe("company");
      expect(detectMission(input)?.target).toBe("github.com");
    },
  );

  it.each([
    "Find the onboarding steps where trial users drop off",
    "audit stripe.com for support automation",
    "localhost:3000",
    "192.168.0.1",
    "ftp://example.com",
    "ops@example.com",
    "example",
    "stripe.com:8443",
  ])("treats %s as a custom goal", (input) => {
    const detected = detectMission(input);
    expect(detected?.kind).toBe("goal");
    expect(detected?.label).toBe("Custom goal");
    expect(detected?.missionIds).toEqual(["custom-goal"]);
    expect(detected?.target).toBe(input.trim());
  });

  it("collapses internal whitespace in goals", () => {
    expect(detectMission("compare   pricing\n pages")?.target).toBe("compare pricing pages");
  });
});
