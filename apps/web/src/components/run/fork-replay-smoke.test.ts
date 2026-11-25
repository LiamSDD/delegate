import { parseRunEvent, type RunEvent } from "@delegate/runtime";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { compareRuns } from "@/lib/runs/compare";
import { initialReplayState, replayReducer } from "@/lib/runs/replay";
import { simulatedScript } from "@/server/fake-runner";

import { CompareView } from "./compare-view";
import { ForkBanner } from "./fork-banner";
import { ForkPanel } from "./fork-panel";
import { ReplayBar } from "./replay-bar";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }));

const PARENT = "00000000-0000-4000-8000-00000000000a";
const FORK = "00000000-0000-4000-8000-00000000000b";
const homepage = "https://acme.test/";

function log(runId: string, forkedFrom?: Record<string, unknown>): RunEvent[] {
  return [
    {
      type: "run.created",
      payload: {
        workspaceId: "w",
        missionId: "company-xray",
        input: { url: homepage, execution: "simulated" },
        actor: { type: "guest", id: "g" },
        budget: { maxTokens: 1, maxMicroUsd: 0 },
        ...(forkedFrom === undefined ? {} : { forkedFrom }),
      },
    },
    ...simulatedScript(runId, homepage),
  ].map((draft, index) =>
    parseRunEvent({
      ...draft,
      runId,
      seq: index + 1,
      at: new Date(1e12 + index * 700).toISOString(),
    }),
  );
}

const html = (text: string) => text.replace(/<!-- -->/g, "");

describe("fork, replay and compare render from simulated logs", () => {
  const parent = log(PARENT);
  const fork = log(FORK, {
    runId: PARENT,
    stepId: "read-pages",
    parentSeq: 12,
    seededThrough: 12,
    objectiveEdited: true,
  });

  it("renders the fork panel with every finished step", () => {
    const panel = html(
      renderToString(
        createElement(ForkPanel, { runId: PARENT, events: parent, onClose: () => undefined }),
      ),
    );
    for (const step of ["map-site", "read-pages", "write-brief"]) expect(panel).toContain(step);
    expect(panel).toContain("Fork from write-brief");
  });

  it("renders the fork banner with timing and a compare link", () => {
    const banner = html(renderToString(createElement(ForkBanner, { runId: FORK, events: fork })));
    expect(banner).toContain("Forked from run 00000000 at step read-pages");
    expect(banner).toContain(`/runs/compare?a=${PARENT}&amp;b=${FORK}`);
    expect(banner).toContain("first new event");
    expect(html(renderToString(createElement(ForkBanner, { runId: PARENT, events: parent })))).toBe(
      "",
    );
  });

  it("labels replay as Replay and shows step markers", () => {
    const state = replayReducer(initialReplayState, { type: "start", total: parent.length });
    const bar = html(
      renderToString(
        createElement(ReplayBar, { events: parent, state, dispatch: () => undefined }),
      ),
    );
    expect(bar).toContain("Replay");
    expect(bar).toContain("no model is called");
    expect(bar).toContain(`Event 1 / ${String(parent.length)}`);
    expect(bar).toContain("read-pages");
  });

  it("renders the comparison table and claim diff", () => {
    const result = compareRuns({ runId: PARENT, events: parent }, { runId: FORK, events: fork });
    if (!result.ok) throw new Error(result.error);
    const page = html(renderToString(createElement(CompareView, result)));
    expect(page).toContain("Citation accuracy");
    expect(page).toContain("Fork of 00000000");
    expect(page).toContain("0 added");
  });
});
