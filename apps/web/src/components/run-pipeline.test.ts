import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { pipelineStats } from "@/server/pipeline-stats";

import { PIPELINE_STEPS, RunPipeline } from "./run-pipeline";

const committed = JSON.parse(
  readFileSync(new URL("../../../../packages/evals/results/redteam.json", import.meta.url), "utf8"),
) as { attacks: number; successes: number };

describe("RunPipeline", () => {
  it("renders the five run stages and the committed red-team result, never models", () => {
    const stats = pipelineStats();
    expect(stats).toEqual({
      attacksBlocked: committed.attacks - committed.successes,
      attacks: committed.attacks,
      suite: "redteam/v2",
    });
    const html = renderToString(createElement(RunPipeline, { stats }));
    for (const step of PIPELINE_STEPS) expect(html).toContain(step.label);
    expect(html).toContain(
      `${String(committed.attacks - committed.successes)}/${String(committed.attacks)}`,
    );
    expect(html).toContain("motion-safe:animate-pipeline-step");
    expect(html).not.toMatch(/model|provider|models\.json|keyless/i);
  });

  it("omits the stat when the report is missing or malformed", () => {
    expect(pipelineStats({ version: 2 })).toBeNull();
    const html = renderToString(createElement(RunPipeline, { stats: null }));
    expect(html).not.toContain("attacks blocked");
    expect(html).toContain("Every citation checked");
  });
});
