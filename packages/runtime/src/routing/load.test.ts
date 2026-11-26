import { beforeEach, describe, expect, it } from "vitest";

import {
  LEARNED_ROUTING_FILE,
  checkLearnedRouting,
  loadLearnedRouting,
  resetLearnedRoutingLog,
} from "./load";

const valid = {
  version: 1,
  generatedAt: "2026-11-25T10:00:00Z",
  source: { resultFiles: ["results/xray.json"], trials: 60 },
  minTrials: 20,
  entries: [
    {
      mission: "company-xray",
      role: "fast",
      order: [
        {
          provider: "nvidia",
          model: "m",
          trials: 30,
          passRate: 0.8,
          ci: [0.6, 0.9],
          p50LatencyMs: null,
        },
      ],
      decision: "learned",
      reason: "enough trials",
    },
  ],
};

function logger() {
  const lines: string[] = [];
  return { lines, log: (line: string) => lines.push(line) };
}

beforeEach(() => {
  resetLearnedRoutingLog();
});

describe("loadLearnedRouting", () => {
  it("returns the parsed file and logs nothing when it is valid", () => {
    const { lines, log } = logger();
    const routing = loadLearnedRouting({ read: () => JSON.stringify(valid), log });
    expect(routing?.entries[0]?.mission).toBe("company-xray");
    expect(lines).toEqual([]);
  });

  it("treats an absent file as no learned routing and says so once per process", () => {
    const { lines, log } = logger();
    expect(loadLearnedRouting({ read: () => undefined, log })).toBeUndefined();
    expect(loadLearnedRouting({ read: () => undefined, log })).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(LEARNED_ROUTING_FILE);
    expect(lines[0]).toMatch(/absent/);
  });

  it("ignores text that is not JSON and says so once", () => {
    const { lines, log } = logger();
    expect(loadLearnedRouting({ read: () => "{ not json", log })).toBeUndefined();
    expect(loadLearnedRouting({ read: () => "{ not json", log })).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/not valid JSON/);
  });

  it("ignores a file of the wrong shape and names the first problems once", () => {
    const { lines, log } = logger();
    const broken = JSON.stringify({ ...valid, minTrials: "many" });
    expect(loadLearnedRouting({ read: () => broken, log })).toBeUndefined();
    expect(loadLearnedRouting({ read: () => broken, log })).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/invalid \(minTrials/);
  });
});

describe("checkLearnedRouting", () => {
  it("validates a value passed in by the host, with the same single log line when it is invalid", () => {
    const { lines, log } = logger();
    expect(checkLearnedRouting(valid, log)?.minTrials).toBe(20);
    expect(checkLearnedRouting({ version: 1 }, log)).toBeUndefined();
    expect(checkLearnedRouting({ version: 1 }, log)).toBeUndefined();
    expect(lines).toHaveLength(1);
  });
});
