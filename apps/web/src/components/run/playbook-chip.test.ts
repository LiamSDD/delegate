import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PlaybookChip } from "./playbook-chip";

describe("PlaybookChip", () => {
  it("renders the learned-from count and every applied entry", () => {
    const html = renderToString(
      createElement(PlaybookChip, {
        applied: {
          key: "company-xray",
          runs: 3,
          tokens: 52,
          sources: [{ scope: "workspace", version: 3 }],
          entries: [
            {
              id: "pb_0a1b2c3d",
              scope: "workspace",
              kind: "source",
              polarity: "keep",
              text: "Cited wikipedia source en.wikipedia.org (2 of 2 fetched pages).",
              evidence: 3,
              score: 0.74,
            },
            {
              id: "pb_1a1b2c3d",
              scope: "workspace",
              kind: "step_slow",
              polarity: "avoid",
              text: "Step read took 41 s, 68% of the run.",
              stepId: "read",
              evidence: 2,
              score: 0.5,
            },
          ],
        },
      }),
    );
    expect(html).toContain("Learned from 3 past runs");
    expect(html).toContain("Cited wikipedia source en.wikipedia.org");
    expect(html).toContain("score 0.74 · 3 runs");
    expect(html).toContain("seen in 2 runs");
    expect(html).toContain("this workspace v3");
    expect(html).toContain('href="/agents/playbooks"');
  });
});
