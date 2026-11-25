import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { EvolutionLogSchema, type EvolutionLog } from "@delegate/evals/evolution";
import {
  CalibrationFileSchema,
  EVAL_MISSIONS,
  EVAL_MISSION_INFO,
  EvalResultFileSchema,
  paretoFrontier,
  scoreboard,
  type CalibrationFile,
  type EvalMission,
  type EvalResultFile,
  type ResultAgreement,
  type ResultMetric,
  type ResultScoreboard,
} from "@delegate/evals/results";
import { z } from "zod";

import { resolveRepoRoot } from "./db";

export const RedteamReportSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string().min(1),
  suite: z.string().regex(/^redteam\/v\d+$/),
  attacks: z.number().int().nonnegative(),
  successes: z.number().int().nonnegative(),
  asr: z.number().min(0).max(1),
  byCategory: z.array(
    z.object({
      category: z.string().min(1),
      attacks: z.number().int().nonnegative(),
      successes: z.number().int().nonnegative(),
    }),
  ),
  cases: z.array(
    z.object({
      id: z.string().min(1),
      category: z.string().min(1),
      blockedBy: z.string(),
      succeeded: z.boolean(),
    }),
  ),
});
export type RedteamReport = z.infer<typeof RedteamReportSchema>;

export type RedteamState =
  { status: "absent" } | { status: "invalid" } | { status: "ok"; report: RedteamReport };

const NON_MISSION_DIRS: ReadonlySet<string> = new Set(["evolution", "calibration", "runs"]);

export interface LoadedResults {
  files: EvalResultFile[];
  calibrations: CalibrationFile[];
  evolution: EvolutionLog[];
  invalid: string[];
}

export type MissionRow =
  | { mission: EvalMission; title: string; dataset: string; status: "no_results" }
  | {
      mission: EvalMission;
      title: string;
      dataset: string;
      status: "ok";
      latest: EvalResultFile;
      board: ResultScoreboard;
      runs: number;
      liveRuns: number;
      metrics: [string, ResultMetric][];
    };

export interface FrontierPoint {
  id: string;
  mission: string;
  mode: EvalResultFile["mode"];
  label: string;
  tokensPerTrial: number;
  costMicroUsdPerTrial: number;
  passRate: number;
  n: number;
  onFrontier: boolean;
}

export interface MissionFrontier {
  mission: EvalMission;
  title: string;
  points: FrontierPoint[];
}

export type Calibration =
  | { mission: EvalMission; title: string; dataset: string; source: "none" }
  | {
      mission: EvalMission;
      title: string;
      dataset: string;
      source: "calibration" | "result";
      reference: string;
      agreement: ResultAgreement;
    };

export interface EvolutionRow {
  id: string;
  mission: string;
  kind: EvolutionLog["kind"];
  finishedAt: string;
  parent: string;
  child: string;
  status: EvolutionLog["decision"]["status"];
  reasons: string[];
  baselineMean: number | null;
  candidateMean: number | null;
  n: { baseline: number; candidate: number };
  pValue: number | null;
  asr: number;
  promotedFile: string | null;
}

export interface EvalsDashboard {
  missions: MissionRow[];
  frontiers: MissionFrontier[];
  calibration: Calibration[];
  evolution: EvolutionRow[];
  invalid: string[];
}

export function evalResultsDir(): string {
  return path.join(resolveRepoRoot(), "packages", "evals", "results");
}

function readJson<T>(file: string, schema: z.ZodType<T>): T | undefined {
  try {
    const parsed = schema.safeParse(JSON.parse(readFileSync(file, "utf8")) as unknown);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function jsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".json") && statSync(path.join(dir, entry)).isFile())
    .sort();
}

export function loadEvalResults(resultsDir: string): LoadedResults {
  const loaded: LoadedResults = { files: [], calibrations: [], evolution: [], invalid: [] };
  if (!existsSync(resultsDir)) return loaded;
  for (const name of readdirSync(resultsDir).sort()) {
    const dir = path.join(resultsDir, name);
    if (NON_MISSION_DIRS.has(name) || !statSync(dir).isDirectory()) continue;
    if (existsSync(path.join(dir, "summary.json"))) continue;
    for (const entry of jsonFiles(dir)) {
      const file = readJson(path.join(dir, entry), EvalResultFileSchema);
      if (file?.mission === name) loaded.files.push(file);
      else loaded.invalid.push(`${name}/${entry}`);
    }
  }
  for (const entry of jsonFiles(path.join(resultsDir, "calibration"))) {
    const file = readJson(path.join(resultsDir, "calibration", entry), CalibrationFileSchema);
    if (file !== undefined && entry === `${file.mission}.json`) loaded.calibrations.push(file);
    else loaded.invalid.push(`calibration/${entry}`);
  }
  for (const entry of jsonFiles(path.join(resultsDir, "evolution"))) {
    const file = readJson(path.join(resultsDir, "evolution", entry), EvolutionLogSchema);
    if (file !== undefined) loaded.evolution.push(file);
    else loaded.invalid.push(`evolution/${entry}`);
  }
  return loaded;
}

export function loadRedteam(file: string): RedteamState {
  if (!existsSync(file)) return { status: "absent" };
  try {
    const parsed = RedteamReportSchema.safeParse(JSON.parse(readFileSync(file, "utf8")) as unknown);
    return parsed.success ? { status: "ok", report: parsed.data } : { status: "invalid" };
  } catch {
    return { status: "invalid" };
  }
}

function modelLabel(file: EvalResultFile): string {
  const planner = file.models
    .filter((entry) => entry.role === "planner")
    .sort((a, b) => b.calls - a.calls)[0];
  const model = planner ?? [...file.models].sort((a, b) => b.calls - a.calls)[0];
  const prompts = Object.entries(file.promptVersions)
    .map(([name, version]) => `${name}@${version}`)
    .join(", ");
  return `${model === undefined ? "no model" : `${model.provider}/${model.model}`} · ${prompts}`;
}

function missionRow(mission: EvalMission, files: readonly EvalResultFile[]): MissionRow {
  const info = EVAL_MISSION_INFO[mission];
  const sorted = [...files].sort((a, b) => a.finishedAt.localeCompare(b.finishedAt));
  const latest = sorted.at(-1);
  if (latest === undefined) return { mission, ...info, status: "no_results" };
  return {
    mission,
    ...info,
    status: "ok",
    latest,
    board: scoreboard(latest),
    runs: files.length,
    liveRuns: files.filter((file) => file.mode === "live").length,
    metrics: Object.entries(latest.missionMetrics ?? {}),
  };
}

function frontierFor(mission: EvalMission, files: readonly EvalResultFile[]): MissionFrontier {
  const candidates = files.flatMap((file) => {
    const board = scoreboard(file);
    if (board.passRate === null || board.meanTokens === null || board.meanCostMicroUsd === null)
      return [];
    return [
      {
        id: `${file.mission}/${file.id}`,
        mission: file.mission,
        mode: file.mode,
        label: modelLabel(file),
        tokensPerTrial: board.meanTokens,
        costMicroUsdPerTrial: board.meanCostMicroUsd,
        passRate: board.passRate.rate,
        n: board.passRate.n,
      },
    ];
  });
  const onFrontier = paretoFrontier(
    candidates.map((point) => ({
      id: point.id,
      cost: point.tokensPerTrial,
      quality: point.passRate,
    })),
  );
  return {
    mission,
    title: EVAL_MISSION_INFO[mission].title,
    points: candidates.map((point) => ({ ...point, onFrontier: onFrontier.has(point.id) })),
  };
}

function calibrationFor(
  mission: EvalMission,
  files: readonly EvalResultFile[],
  calibration: CalibrationFile | undefined,
): Calibration {
  const info = EVAL_MISSION_INFO[mission];
  if (calibration !== undefined)
    return {
      mission,
      ...info,
      source: "calibration",
      reference: `results/calibration/${mission}.json · ${calibration.generatedAt}`,
      agreement: calibration.agreement,
    };
  const sorted = [...files].sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));
  const chosen = sorted.find((file) => file.agreement.status !== "no_human_labels") ?? sorted[0];
  if (chosen === undefined) return { mission, ...info, source: "none" };
  return { mission, ...info, source: "result", reference: chosen.id, agreement: chosen.agreement };
}

function ref(entry: {
  prompt: { name: string; version: number };
  playbook: { key: string; version: number };
}) {
  return `${entry.prompt.name}@${entry.prompt.version} · playbook ${entry.playbook.key} v${entry.playbook.version}`;
}

export function evolutionRows(logs: readonly EvolutionLog[]): EvolutionRow[] {
  return [...logs]
    .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))
    .map((log) => ({
      id: log.id,
      mission: log.mission,
      kind: log.kind,
      finishedAt: log.finishedAt,
      parent: ref(log.parent),
      child: ref(log.child),
      status: log.decision.status,
      reasons: log.decision.reasons,
      baselineMean: log.decision.baseline.mean,
      candidateMean: log.decision.candidate.mean,
      n: { baseline: log.decision.baseline.n, candidate: log.decision.candidate.n },
      pValue: log.decision.improvement?.pValue ?? null,
      asr: log.redteam.asr,
      promotedFile: log.promotion?.file ?? null,
    }));
}

export function buildDashboard(loaded: LoadedResults): EvalsDashboard {
  const byMission = new Map<string, EvalResultFile[]>();
  for (const file of loaded.files)
    byMission.set(file.mission, [...(byMission.get(file.mission) ?? []), file]);
  const unknown = [...byMission.keys()].filter(
    (mission) => !(EVAL_MISSIONS as readonly string[]).includes(mission),
  );
  return {
    missions: EVAL_MISSIONS.map((mission) => missionRow(mission, byMission.get(mission) ?? [])),
    frontiers: EVAL_MISSIONS.map((mission) => frontierFor(mission, byMission.get(mission) ?? [])),
    calibration: EVAL_MISSIONS.map((mission) =>
      calibrationFor(
        mission,
        byMission.get(mission) ?? [],
        loaded.calibrations.find((file) => file.mission === mission),
      ),
    ),
    evolution: evolutionRows(loaded.evolution),
    invalid: [...loaded.invalid, ...unknown.map((mission) => `${mission}/ (unknown mission)`)],
  };
}
