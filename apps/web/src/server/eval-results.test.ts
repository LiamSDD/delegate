import path from "node:path";

import { EVAL_MISSIONS } from "@delegate/evals/results";
import { describe, expect, it } from "vitest";

import { buildDashboard, loadEvalResults, loadRedteam } from "./eval-results";

const FIXTURES = path.join(import.meta.dirname, "fixtures", "eval-results");

describe("loadEvalResults", () => {
  it("reads mission result files, calibration and evolution logs, skips raw runs and reports invalid files", () => {
    const loaded = loadEvalResults(FIXTURES);
    expect(loaded.files.map((file) => `${file.mission}/${file.id}`)).toEqual([
      "audit/2026-11-25T11-00-00-000Z",
      "xray/2026-11-24T10-00-00-000Z",
      "xray/2026-11-25T10-00-00-000Z",
    ]);
    expect(loaded.calibrations.map((file) => file.mission)).toEqual(["goal"]);
    expect(loaded.evolution.map((log) => log.id)).toEqual(["evo-1", "evo-2"]);
    expect(loaded.invalid).toEqual([
      "xray/broken.json",
      "calibration/repo.json",
      "evolution/broken.json",
    ]);
  });

  it("returns nothing for a missing results directory", () => {
    expect(loadEvalResults(path.join(FIXTURES, "missing"))).toEqual({
      files: [],
      calibrations: [],
      evolution: [],
      invalid: [],
    });
  });
});

describe("buildDashboard", () => {
  const dashboard = buildDashboard(loadEvalResults(FIXTURES));

  it("has one row per mission, with an honest empty state where nothing has run", () => {
    expect(dashboard.missions.map((row) => [row.mission, row.status])).toEqual([
      ["xray", "ok"],
      ["audit", "ok"],
      ["build", "no_results"],
      ["repo", "no_results"],
      ["goal", "no_results"],
    ]);
    const [xray, audit] = dashboard.missions;
    if (xray?.status !== "ok" || audit?.status !== "ok") throw new Error("expected results");
    expect(xray.runs).toBe(2);
    expect(xray.latest.id).toBe("2026-11-25T10-00-00-000Z");
    expect(xray.board.passRate).toMatchObject({ rate: 0, n: 2 });
    expect(xray.board.citationAccuracy).toMatchObject({ rate: 1, n: 2 });
    expect(audit.liveRuns).toBe(0);
    expect(audit.metrics.map(([name]) => name)).toEqual([
      "opportunities",
      "workflowRecall",
      "unlisted",
    ]);
  });

  it("marks the cost-quality frontier within each mission", () => {
    expect(dashboard.frontiers.map((entry) => [entry.mission, entry.points.length])).toEqual(
      EVAL_MISSIONS.map((mission) => [
        mission,
        mission === "xray" ? 2 : mission === "audit" ? 1 : 0,
      ]),
    );
    const xray = dashboard.frontiers[0]?.points ?? [];
    const older = xray.find((point) => point.id.endsWith("2026-11-24T10-00-00-000Z"));
    const newer = xray.find((point) => point.id.endsWith("2026-11-25T10-00-00-000Z"));
    expect(older).toMatchObject({ tokensPerTrial: 10000, passRate: 0.5, onFrontier: true });
    expect(newer).toMatchObject({ tokensPerTrial: 30000, passRate: 0, onFrontier: false });
    expect(older?.label).toBe("fixture/big · company-xray-synthesis@1, xray-judge@1");
    expect(dashboard.frontiers[1]?.points[0]?.onFrontier).toBe(true);
  });

  it("prefers the calibration file, then the newest labelled result, per mission", () => {
    expect(
      dashboard.calibration.map((entry) => [
        entry.mission,
        entry.source,
        entry.source === "none" ? null : entry.agreement.status,
      ]),
    ).toEqual([
      ["xray", "result", "ok"],
      ["audit", "result", "no_human_labels"],
      ["build", "none", null],
      ["repo", "none", null],
      ["goal", "calibration", "ok"],
    ]);
    const xray = dashboard.calibration[0];
    expect(xray?.source === "result" ? xray.reference : null).toBe("2026-11-25T10-00-00-000Z");
  });

  it("lists evolution runs newest first with lineage and the gate decision", () => {
    expect(dashboard.evolution.map((row) => [row.id, row.status])).toEqual([
      ["evo-2", "promoted"],
      ["evo-1", "rejected"],
    ]);
    expect(dashboard.evolution[0]).toMatchObject({
      parent: "planner@2 · playbook company-xray v0",
      child: "planner@4 · playbook company-xray v0",
      candidateMean: 0.72,
      pValue: 0.01,
      promotedFile: "packages/runtime/prompts/planner.v4.md",
    });
    expect(dashboard.evolution[1]?.promotedFile).toBeNull();
  });
});

describe("loadRedteam", () => {
  it("parses the red-team report", () => {
    const state = loadRedteam(path.join(FIXTURES, "redteam.json"));
    expect(state.status).toBe("ok");
    if (state.status === "ok") expect(state.report.byCategory).toHaveLength(2);
  });

  it("is absent when the suite has not run and invalid when the file is malformed", () => {
    expect(loadRedteam(path.join(FIXTURES, "nope.json"))).toEqual({ status: "absent" });
    expect(loadRedteam(path.join(FIXTURES, "xray", "broken.json"))).toEqual({
      status: "invalid",
    });
  });
});
