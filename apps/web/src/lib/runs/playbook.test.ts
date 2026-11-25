import { describe, expect, it } from "vitest";

import { entryStat, learnedLabel, sourcesLabel } from "./playbook";

describe("playbook labels", () => {
  it("counts past runs honestly", () => {
    expect(learnedLabel(1)).toBe("Learned from 1 past run");
    expect(learnedLabel(12)).toBe("Learned from 12 past runs");
  });

  it("names versions per scope and shows score only for keep entries", () => {
    expect(
      sourcesLabel({
        key: "company-xray",
        runs: 5,
        tokens: 40,
        sources: [
          { scope: "workspace", version: 3 },
          { scope: "house", version: 7 },
        ],
        entries: [
          {
            id: "pb_00000001",
            scope: "house",
            kind: "plan_shape",
            polarity: "keep",
            text: "A.",
            evidence: 1,
            score: 0.6,
          },
        ],
      }),
    ).toBe("this workspace v3 · house v7");
    const base = { id: "pb_00000001", scope: "house" as const, kind: "x", text: "A." };
    expect(entryStat({ ...base, polarity: "keep", evidence: 4, score: 0.8125 })).toBe(
      "score 0.81 · 4 runs",
    );
    expect(entryStat({ ...base, polarity: "avoid", evidence: 1, score: 0.2 })).toBe(
      "seen in 1 run",
    );
  });
});
