import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildDashboard, loadEvalResults, loadRedteam } from "./eval-results";

const FIXTURES = path.join(import.meta.dirname, "fixtures", "eval-results");

describe("loadEvalResults", () => {
  it("reads mission result files, skips raw run directories and reports invalid files", () => {
    const loaded = loadEvalResults(FIXTURES);
    expect(loaded.files.map((file) => file.id)).toEqual([
      "2026-11-24T10-00-00-000Z",
      "2026-11-25T10-00-00-000Z",
    ]);
    expect(loaded.invalid).toEqual(["xray/broken.json"]);
  });

  it("returns nothing for a missing results directory", () => {
    expect(loadEvalResults(path.join(FIXTURES, "missing"))).toEqual({ files: [], invalid: [] });
  });
});

describe("buildDashboard", () => {
  const dashboard = buildDashboard(loadEvalResults(FIXTURES));

  it("scores each mission from its latest result file", () => {
    expect(dashboard.missions).toHaveLength(1);
    const [xray] = dashboard.missions;
    expect(xray?.runs).toBe(2);
    expect(xray?.latest.id).toBe("2026-11-25T10-00-00-000Z");
    expect(xray?.board.passRate).toMatchObject({ rate: 0, n: 2 });
    expect(xray?.board.citationAccuracy).toMatchObject({ rate: 1, n: 2 });
  });

  it("marks the cost-quality frontier per mission", () => {
    const older = dashboard.frontier.find((point) => point.id.endsWith("2026-11-24T10-00-00-000Z"));
    const newer = dashboard.frontier.find((point) => point.id.endsWith("2026-11-25T10-00-00-000Z"));
    expect(older).toMatchObject({ tokensPerTrial: 10000, passRate: 0.5, onFrontier: true });
    expect(newer).toMatchObject({ tokensPerTrial: 30000, passRate: 0, onFrontier: false });
    expect(older?.label).toBe("fixture/big · company-xray-synthesis@1, xray-judge@1");
  });

  it("uses the newest result file that has human labels for calibration", () => {
    expect(dashboard.calibration[0]).toMatchObject({
      mission: "xray",
      resultId: "2026-11-25T10-00-00-000Z",
      agreement: { status: "ok", matched: 2 },
    });
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
