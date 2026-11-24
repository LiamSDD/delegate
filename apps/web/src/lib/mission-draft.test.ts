import { describe, expect, it } from "vitest";

import { MAX_INPUT_LENGTH } from "./detect-mission";
import { draftFromQuery } from "./mission-draft";

describe("draftFromQuery", () => {
  it("returns null when there is no usable input", () => {
    expect(draftFromQuery(undefined)).toBeNull();
    expect(draftFromQuery("   ")).toBeNull();
    expect(draftFromQuery([])).toBeNull();
  });

  it("uses the first value when a parameter repeats", () => {
    expect(draftFromQuery(["stripe.com", "linear.app"])?.detected.target).toBe("stripe.com");
  });

  it("chains the company missions and reports the earliest and latest arrival", () => {
    const draft = draftFromQuery("https://stripe.com");
    expect(draft?.missions.map((mission) => mission.id)).toEqual([
      "company-xray",
      "automation-audit",
    ]);
    expect(draft?.firstArrival).toBe("M1");
    expect(draft?.fullArrival).toBe("M2");
  });

  it("describes a repo draft", () => {
    const draft = draftFromQuery("github.com/vercel/next.js");
    expect(draft?.detected.kind).toBe("repo");
    expect(draft?.firstArrival).toBe("M5");
    expect(draft?.fullArrival).toBe("M5");
  });

  it("truncates oversized input instead of echoing it whole", () => {
    const draft = draftFromQuery(`goal ${"x".repeat(MAX_INPUT_LENGTH * 2)}`);
    expect(draft?.input.length).toBe(MAX_INPUT_LENGTH);
    expect(draft?.truncated).toBe(true);
  });
});
