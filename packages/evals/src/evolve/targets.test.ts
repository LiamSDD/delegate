import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { housePlaybookKeys } from "@delegate/runtime";
import { RUNTIME_PROMPT_FILES, loadRuntimePrompts } from "@delegate/runtime/server";
import { afterEach, describe, expect, it } from "vitest";

import { EVAL_MISSIONS, missionAdapter } from "../missions";
import { runEval, type RunEvalOptions, type TrialRecord } from "../runner";
import { scriptedEvalDeps } from "../testing/scripted-deps";
import { runMissionGates } from "./gate-run";
import {
  MISSION_TARGETS,
  SHARED_PROMPTS,
  missionGateVerdict,
  type GateSummaryView,
} from "./targets";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "targets-"));
  dirs.push(dir);
  return dir;
}

function baseOptions(resultsDir: string): RunEvalOptions {
  return {
    trials: 1,
    audience: "public-demo",
    offline: false,
    concurrency: 1,
    baseline: false,
    judge: false,
    resultsDir,
    threshold: 0.05,
  };
}

describe("mission targets", () => {
  it("mirrors each adapter and only lets a candidate change the mission's own prompts", () => {
    const live = loadRuntimePrompts();
    const claimed = new Map<string, string>();
    for (const mission of EVAL_MISSIONS) {
      const adapter = missionAdapter(mission);
      const targets = MISSION_TARGETS[mission];
      expect(targets.mission).toBe(mission);
      expect(targets.runtimeMissionId).toBe(adapter.runtimeMissionId);
      expect([...targets.runtimePrompts]).toEqual([...adapter.runtimePrompts]);
      expect(targets.prompts.length).toBeGreaterThan(0);
      for (const key of targets.prompts) {
        expect(adapter.runtimePrompts).toContain(key);
        expect(SHARED_PROMPTS).not.toContain(key);
        expect(RUNTIME_PROMPT_FILES[key].startsWith(`${adapter.runtimeMissionId}.`)).toBe(true);
        expect(live[key].name.startsWith(`${adapter.runtimeMissionId}.`)).toBe(true);
        expect(claimed.get(key)).toBeUndefined();
        claimed.set(key, mission);
      }
      for (const forbidden of ["reader", "critic", "grader", "answer"])
        expect(targets.prompts).not.toContain(forbidden);
    }
  });

  it("names the playbook keys the runtime resolves for the dataset inputs", () => {
    for (const mission of EVAL_MISSIONS) {
      const adapter = missionAdapter(mission);
      const targets = MISSION_TARGETS[mission];
      const keys = housePlaybookKeys(
        adapter.runtimeMissionId,
        adapter.loadCases().map((c) => adapter.input(c)),
      );
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(key.split(":")[0]).toBe(targets.runtimeMissionId);
        expect(key.includes(":")).toBe(targets.playbooks === "goal-category");
      }
    }
  });

  it("lists exactly the hard checks each mission's grader emits", async () => {
    for (const mission of EVAL_MISSIONS) {
      const adapter = missionAdapter(mission);
      const cases = adapter.loadCases();
      const chosen = cases.find((c) => c.tags.includes("gate")) ?? cases[0];
      const records: TrialRecord[] = [];
      await runEval(
        { ...baseOptions(tempDir()), mission, caseIds: [chosen?.id ?? ""] },
        scriptedEvalDeps({ onTrial: (record) => records.push(record) }),
      );
      const hard = new Set(
        records.flatMap((record) =>
          record.checks.filter((check) => check.severity === "hard").map((check) => check.kind),
        ),
      );
      expect([...hard].sort()).toEqual([...MISSION_TARGETS[mission].hardChecks].sort());
    }
  });
});

describe("mission gate", () => {
  const view = (patch: Partial<GateSummaryView["overall"]>, extra: Partial<GateSummaryView> = {}) =>
    ({
      mission: "repo",
      overall: {
        trials: 4,
        errored: 0,
        hardFailures: 0,
        checkPassRates: {
          run_completed: { passed: 4, counted: 4 },
          mermaid_nodes_real: { passed: 4, counted: 4 },
          max_latency_ms: { passed: 1, counted: 4 },
        },
        ...patch,
      },
      regressions: [],
      ...extra,
    }) satisfies GateSummaryView;

  it("passes on clean hard checks whatever the soft checks say", () => {
    expect(missionGateVerdict(view({}))).toMatchObject({ ok: true, failedHardChecks: [] });
  });

  it("names the mission's failing hard checks", () => {
    const verdict = missionGateVerdict(
      view({
        hardFailures: 2,
        checkPassRates: {
          mermaid_nodes_real: { passed: 2, counted: 4 },
          improvements_valid: { passed: 3, counted: 4 },
          max_latency_ms: { passed: 0, counted: 4 },
        },
      }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.failedHardChecks).toEqual([
      { kind: "mermaid_nodes_real", failed: 2, counted: 4 },
      { kind: "improvements_valid", failed: 1, counted: 4 },
    ]);
    expect(verdict.message).toBe(
      "failed: hard checks failed: mermaid_nodes_real 2/4, improvements_valid 1/4",
    );
  });

  it("fails on a regression against the mission baseline and when every trial errored", () => {
    const regressed = missionGateVerdict(
      view(
        {},
        { regressions: [{ scope: "overall", metric: "score", worsening: 0.2, pValue: 0.01 }] },
      ),
    );
    expect(regressed.message).toBe("failed: overall score regressed by 0.200 (p=0.010)");
    const errored = missionGateVerdict(view({ errored: 4 }));
    expect(errored.ok).toBe(false);
    expect(errored.message).toMatch(/every trial errored/);
  });

  it("runs every selected mission on its gate-tagged cases with the mission threshold", async () => {
    const seen: string[] = [];
    const result = await runMissionGates(
      { missions: EVAL_MISSIONS, full: false, base: baseOptions(tempDir()) },
      scriptedEvalDeps({
        onTrial: (record) => seen.push(record.caseId),
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.verdicts.map((verdict) => verdict.mission)).toEqual([...EVAL_MISSIONS]);
    expect(result.verdicts.every((verdict) => verdict.mode === "live")).toBe(true);
    const gateCases = EVAL_MISSIONS.flatMap((mission) =>
      missionAdapter(mission)
        .loadCases()
        .filter((c) => c.tags.includes("gate"))
        .map((c) => c.id),
    );
    expect([...seen].sort()).toEqual([...gateCases].sort());
  });

  it("fails the whole gate when one mission has a hard failure", async () => {
    const result = await runMissionGates(
      { missions: ["xray", "goal"], full: false, base: baseOptions(tempDir()) },
      scriptedEvalDeps({
        runMission: async (options) => {
          if (options.missionId === "custom-goal") {
            await options.emit({
              runId: options.runId,
              type: "run.failed",
              payload: { error: { code: "invalid_output", message: "no brief" } },
            });
            return { status: "failed" };
          }
          return scriptedEvalDeps().runMission(options);
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.verdicts.map((verdict) => verdict.ok)).toEqual([true, false]);
    expect(result.verdicts[1]?.failedHardChecks.map((row) => row.kind)).toContain("run_completed");
  });
});
