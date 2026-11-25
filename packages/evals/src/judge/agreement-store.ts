import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { humanLabelsPath } from "../datasets/jsonl";
import { type EvalMission, type MissionAdapter } from "../missions/adapter";
import {
  CALIBRATION_FILE_VERSION,
  CalibrationFileSchema,
  type CalibrationFile,
  type ResultAgreement,
} from "../results";
import {
  agreementReport,
  loadHumanLabels,
  type AgreementReport,
  type HumanLabel,
  type JudgedTrial,
} from "./calibration";
import { verdictScores } from "./rubric-judge";

export const JudgeRecordSchema = z.object({
  provider: z.string(),
  model: z.string(),
  promptName: z.string(),
  promptVersion: z.number().int().positive(),
  repaired: z.boolean(),
  verdict: z.record(z.string(), z.unknown()),
});
export type JudgeRecord = z.infer<typeof JudgeRecordSchema>;

export function runsDir(resultsDir: string, mission: EvalMission): string {
  return join(resultsDir, "runs", mission);
}

export function runDir(resultsDir: string, mission: EvalMission, id: string): string {
  return join(runsDir(resultsDir, mission), id);
}

function storedRunDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .filter((name) => existsSync(join(dir, name, "summary.json")))
    .sort();
}

function legacyXrayRun(resultsDir: string, name: string): boolean {
  try {
    const summary = z
      .object({ mission: z.string() })
      .safeParse(JSON.parse(readFileSync(join(resultsDir, name, "summary.json"), "utf8")));
    return summary.success && summary.data.mission === "xray";
  } catch {
    return false;
  }
}

export function storedRuns(
  resultsDir: string,
  mission: EvalMission,
): { id: string; dir: string }[] {
  const current = storedRunDirs(runsDir(resultsDir, mission)).map((id) => ({
    id,
    dir: runDir(resultsDir, mission, id),
  }));
  if (mission !== "xray") return current;
  const legacy = storedRunDirs(resultsDir)
    .filter((name) => legacyXrayRun(resultsDir, name))
    .map((id) => ({ id, dir: join(resultsDir, id) }));
  return [...legacy, ...current].sort((a, b) => a.id.localeCompare(b.id));
}

export function latestRunDir(resultsDir: string, mission: EvalMission): string | undefined {
  return storedRuns(resultsDir, mission).at(-1)?.dir;
}

export function findRunDir(
  resultsDir: string,
  mission: EvalMission,
  run: string,
): string | undefined {
  return storedRuns(resultsDir, mission).find((entry) => entry.id === run)?.dir;
}

export function trialFile(dir: string, caseId: string, trial: number, suffix: string): string {
  return join(dir, caseId, `${trial}.${suffix}`);
}

export function readJudgeRecord(path: string): JudgeRecord | undefined {
  if (!existsSync(path)) return undefined;
  const parsed = JudgeRecordSchema.safeParse(JSON.parse(readFileSync(path, "utf8")) as unknown);
  return parsed.success ? parsed.data : undefined;
}

export function storedJudgements(
  resultsDir: string,
  adapter: MissionAdapter,
  labels: readonly HumanLabel[],
): JudgedTrial[] {
  const dirs = new Map<string, string | undefined>();
  return labels.flatMap((label) => {
    if (!dirs.has(label.run))
      dirs.set(label.run, findRunDir(resultsDir, adapter.mission, label.run));
    const dir = dirs.get(label.run);
    if (dir === undefined) return [];
    const record = readJudgeRecord(trialFile(dir, label.caseId, label.trial, "judge.json"));
    const scores =
      record === undefined ? undefined : verdictScores(record.verdict, adapter.judge.criteria);
    return scores === undefined
      ? []
      : [{ caseId: label.caseId, run: label.run, trial: label.trial, scores }];
  });
}

export function missionAgreement(
  resultsDir: string,
  adapter: MissionAdapter,
  extra: readonly JudgedTrial[] = [],
): AgreementReport {
  const labels = loadHumanLabels(humanLabelsPath(adapter.dataset), adapter.judge.criteria);
  const judged = new Map<string, JudgedTrial>();
  for (const entry of [...storedJudgements(resultsDir, adapter, labels), ...extra])
    judged.set(`${entry.run}/${entry.caseId}/${entry.trial}`, entry);
  return agreementReport(labels, [...judged.values()], adapter.judge.criteria);
}

export function toResultAgreement(report: AgreementReport): ResultAgreement {
  if (report.status !== "ok") return report;
  return {
    ...report,
    criteria: report.criteria.map((row) => ({
      criterion: row.criterion,
      n: row.n,
      exactMatchRate: row.exactMatchRate,
      withinOneRate: row.withinOneRate,
      kappa: row.kappa ?? null,
      kappaLower: row.kappaInterval?.lower ?? null,
      kappaUpper: row.kappaInterval?.upper ?? null,
    })),
  };
}

export function calibrationPath(resultsDir: string, mission: EvalMission): string {
  return join(resultsDir, "calibration", `${mission}.json`);
}

export function writeCalibration(
  resultsDir: string,
  adapter: MissionAdapter,
  report: AgreementReport,
  now: Date,
): CalibrationFile {
  const file = CalibrationFileSchema.parse({
    version: CALIBRATION_FILE_VERSION,
    mission: adapter.mission,
    generatedAt: now.toISOString(),
    labelsFile: `datasets/${adapter.dataset.name}/human-labels.v1.jsonl`,
    criteria: [...adapter.judge.criteria],
    agreement: toResultAgreement(report),
  });
  const path = calibrationPath(resultsDir, adapter.mission);
  mkdirSync(join(resultsDir, "calibration"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
  return file;
}
