import {
  type GoalBrief,
  parseRunEvent,
  type RunEvent,
  type RunEventDraft,
} from "@delegate/runtime";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { goalBriefToMarkdown, parseGoalBrief } from "@/lib/runs/goal";
import { buildRunView } from "@/lib/runs/run-view";

import { GoalBriefPanel } from "./goal-panel";

const RUN = "00000000-0000-4000-8000-00000000000b";
const AT = "2026-11-25T10:00:00.000Z";

const brief: GoalBrief = {
  missionId: "custom-goal",
  status: "complete",
  goal: "I want to achieve acme's marketing and agentic work",
  objective: "Raise marketing reach at Acme and automate repetitive work with agents.",
  company: {
    name: "Acme Robotics",
    url: "https://www.acme.example/",
    resolvedBy: "wikidata",
    entity: "Q8",
  },
  workstreams: [
    {
      name: "Marketing",
      findings: [{ text: "Acme sells picking robots to 3PL providers.", citations: ["S1"] }],
    },
  ],
  actions: [
    {
      rank: 1,
      score: 1.5,
      title: "Map the order-handling workflow for automation",
      owner: "Head of Operations",
      effort: "medium",
      impact: "high",
      mission: "automation-audit",
      basis: { text: "Acme integrates with SAP and Manhattan WMS.", citations: ["S2"] },
    },
  ],
  risks: [{ text: "Marketing claims need sources.", citations: ["S1"], support: "weak" }],
  openQuestions: ["What budget is available?"],
  sources: [
    {
      sourceId: "S1",
      url: "https://www.acme.example/",
      title: "Acme Robotics",
      kind: "company_site",
      fetchedAt: AT,
      quotes: ["Acme Robotics builds autonomous picking robots"],
    },
    {
      sourceId: "S2",
      url: "https://en.wikipedia.org/wiki/Acme_Robotics",
      title: "Wikipedia: Acme Robotics",
      kind: "wikipedia",
      fetchedAt: AT,
      quotes: ["integrates with SAP"],
    },
  ],
  sourceMix: { company_site: 1, wikipedia: 1, wikidata: 0, github: 0, feed: 0, connector: 0 },
  rankFormula: "score = impact ÷ effort",
  generatedAt: AT,
  promptVersions: ["custom-goal.synthesis@1"],
};

function log(drafts: Omit<RunEventDraft, "runId">[]): RunEvent[] {
  return drafts.map((draft, index) =>
    parseRunEvent({ ...draft, runId: RUN, seq: index + 1, at: AT }),
  );
}

describe("goal brief rendering", () => {
  it("builds the run view from a custom-goal log and renders the cited brief", () => {
    const events = log([
      {
        type: "run.created",
        payload: {
          workspaceId: "w",
          missionId: "custom-goal",
          input: { goal: brief.goal },
          actor: { type: "guest", id: "g" },
          budget: { maxTokens: 1, maxMicroUsd: 0 },
        },
      },
      {
        type: "artifact.created",
        payload: {
          artifactId: "a1",
          kind: "goal-brief",
          title: "Goal brief",
          version: 1,
          content: brief,
        },
      },
    ]);
    const view = buildRunView(events);
    if (!view.ok) throw new Error(view.error);
    expect(view.goal?.artifactId).toBe("a1");
    expect(view.brief).toBeNull();
    expect(view.target).toBe(brief.goal);

    const html = renderToString(
      createElement(GoalBriefPanel, { artifact: view.goal, running: false }),
    );
    expect(html).toContain(brief.objective);
    expect(html).toContain("resolved via Wikidata Q8");
    expect(html).toContain("Map the order-handling workflow for automation");
    expect(html).toContain("Head of Operations");
    expect(html).toContain("Automation Audit");
    expect(html).toContain("What budget is available?");
    expect(html).toContain('aria-label="Citation 1"');
  });

  it("refuses malformed or unsafe content instead of guessing", () => {
    expect(parseGoalBrief({ missionId: "custom-goal" }).ok).toBe(false);
    const unsafe = parseGoalBrief({
      ...brief,
      sources: [{ ...brief.sources[0], url: "javascript:alert(1)" }],
    });
    expect(unsafe.ok).toBe(false);
    const html = renderToString(createElement(GoalBriefPanel, { artifact: null, running: true }));
    expect(html).toContain("renders here");
  });

  it("exports Markdown with numbered citations", () => {
    const parsed = parseGoalBrief(brief);
    if (!parsed.ok) throw new Error("invalid");
    const markdown = goalBriefToMarkdown(parsed.brief);
    expect(markdown).toContain("## Marketing");
    expect(markdown).toContain("1. **Map the order-handling workflow for automation**");
    expect(markdown).toContain("[2]");
  });
});
