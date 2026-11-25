import { type RunMissionOptions } from "@delegate/runtime/server";

import { loadAuditDataset } from "../datasets/audit";
import { loadBuildDataset } from "../datasets/build";
import { loadCustomGoalDataset } from "../datasets/custom-goal";
import { EVAL_MISSIONS, missionAdapter } from "../missions";
import { type RunEvalDeps } from "../runner";
import {
  auditFixtureDrafts,
  buildFixtureDrafts,
  fixtureAnswers,
  goalFixtureDrafts,
  scriptedRunMission,
} from "./mission-fixtures";
import { repoFixtureEvents } from "./repo-fixture";
import { xrayFixtureEvents } from "./xray-fixture";

export const ALL_CRITERIA_VERDICT = JSON.stringify(
  Object.fromEntries(
    EVAL_MISSIONS.flatMap((mission) => missionAdapter(mission).judge.criteria).map((criterion) => [
      criterion,
      { score: 4, rationale: "scripted fixture verdict" },
    ]),
  ),
);

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function found<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`No fixture for ${what}`);
  return value;
}

export async function fixtureDraftsFor(options: RunMissionOptions) {
  switch (options.missionId) {
    case "automation-audit":
      return auditFixtureDrafts(
        found(
          loadAuditDataset().find((c) => same(c.input, options.input)),
          "automation-audit input",
        ),
      );
    case "build-agent":
      return buildFixtureDrafts(
        found(
          loadBuildDataset().find((c) => same(c.input, options.input)),
          "build-agent input",
        ),
      );
    case "custom-goal":
      return goalFixtureDrafts(
        found(
          loadCustomGoalDataset().find((c) => same(c.input, options.input)),
          "custom-goal input",
        ),
      );
    case "repo-xray": {
      const input = options.input as { url?: unknown };
      return (await repoFixtureEvents(String(input.url))).map(
        ({ seq: _seq, at: _at, runId: _runId, ...draft }) => draft,
      );
    }
    default:
      return (await xrayFixtureEvents()).map(
        ({ seq: _seq, at: _at, runId: _runId, ...draft }) => draft,
      );
  }
}

export function scriptedEvalDeps(overrides: Partial<RunEvalDeps> = {}): RunEvalDeps {
  let tick = Date.parse("2026-11-25T10:00:00.000Z");
  return {
    runMission: scriptedRunMission(fixtureDraftsFor),
    env: {},
    now: () => new Date((tick += 250)),
    sleep: () => Promise.resolve(),
    judgeCompleter: {
      complete: () =>
        Promise.resolve({ text: ALL_CRITERIA_VERDICT, provider: "fixture", model: "judge" }),
    },
    checkLinks: (urls) => Promise.resolve(new Map(urls.map((url) => [url, { ok: true }]))),
    answerQuestion: fixtureAnswers(loadBuildDataset()),
    log: () => undefined,
    ...overrides,
  };
}
