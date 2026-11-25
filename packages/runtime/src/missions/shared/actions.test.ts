import { describe, expect, it } from "vitest";

import { checkActionConcreteness, isMeasurable, namesOnlyAMission } from "./actions";

describe("namesOnlyAMission", () => {
  it.each([
    "Run a company-xray on Nike",
    "Run a Company X-ray on Nike, Inc.",
    "Run an automation audit",
    "Perform an AI automation audit for Nike",
    "Start the repo x-ray",
  ])("rejects %s", (title) => {
    expect(namesOnlyAMission(title)).toBe(true);
  });

  it.each([
    "Audit Nike's customer-service workflows on nike.com/help",
    "Run an automation audit on Nike customer service returns workflows",
    "Map the order-handling workflow for automation",
    "Build an agent that answers sizing questions from the Nike size guide",
  ])("accepts %s", (title) => {
    expect(namesOnlyAMission(title)).toBe(false);
  });
});

describe("checkActionConcreteness", () => {
  it("accepts an action with scope, a first step and a measurable metric", () => {
    expect(
      checkActionConcreteness({
        title: "Audit the returns workflow on the help centre",
        firstStep: "Export last month's returns tickets from the help desk",
        successMetric: "Cut median return handling time from 3 days to 1 day",
      }),
    ).toEqual([]);
  });

  it("explains every missing part", () => {
    const reasons = checkActionConcreteness({
      title: "Run a company-xray on Nike",
      firstStep: "Explore options",
      successMetric: "Better brand",
    });
    expect(reasons).toHaveLength(3);
    expect(reasons.join("; ")).toMatch(/only says to run a mission/);
    expect(checkActionConcreteness({ title: "Do X for Y team" }).join("; ")).toMatch(
      /no first concrete step.*no success metric/,
    );
  });

  it("treats numbers, rates and durations as measurable", () => {
    expect(isMeasurable("3 campaign KPIs reported weekly")).toBe(true);
    expect(isMeasurable("Conversion rate on the launch page")).toBe(true);
    expect(isMeasurable("Happier customers")).toBe(false);
  });
});
