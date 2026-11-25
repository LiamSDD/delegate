import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { EvolutionLogSchema, type EvolutionLog } from "@delegate/evals/evolution";
import { LearnedRoutingSchema, type LearnedRouting } from "@delegate/evals/routing";
import {
  MISSION_TARGETS,
  TrainingRecordSchema,
  type TrainingRecord,
} from "@delegate/evals/training";
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
import { housePlaybookKeyOfFile, parseHousePlaybook, parsePromptFile } from "@delegate/runtime";
import { RUNTIME_PROMPT_FILES } from "@delegate/runtime/server";
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

const NON_MISSION_DIRS: ReadonlySet<string> = new Set([
  "evolution",
  "calibration",
  "runs",
  "training",
]);

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

export interface LoadedTraining {
  records: TrainingRecord[];
  invalid: string[];
}

export function loadTraining(trainingDir: string): LoadedTraining {
  const loaded: LoadedTraining = { records: [], invalid: [] };
  for (const entry of jsonFiles(trainingDir)) {
    const record = readJson(path.join(trainingDir, entry), TrainingRecordSchema);
    if (record !== undefined && entry === `${record.id}.json`) loaded.records.push(record);
    else loaded.invalid.push(`training/${entry}`);
  }
  loaded.records.sort(
    (a, b) => b.finishedAt.localeCompare(a.finishedAt) || b.id.localeCompare(a.id),
  );
  return loaded;
}

export interface TrainingArmView {
  source: TrainingRecord["arms"]["baseline"]["source"];
  mean: number | null;
  lower: number | null;
  upper: number | null;
  n: number;
  errored: number;
}

export interface TrainingDelta {
  kind: "paired" | "pooled";
  value: number;
  lower: number | null;
  upper: number | null;
  pValue: number;
  units: string;
}

export interface TrainingRow {
  id: string;
  mission: EvalMission;
  title: string;
  round: number;
  kind: TrainingRecord["kind"];
  finishedAt: string;
  status: TrainingRecord["decision"]["status"];
  change: string;
  baseline: TrainingArmView;
  candidate: TrainingArmView | null;
  delta: TrainingDelta | null;
  alpha: number;
  comparisons: number;
  reasons: string[];
  promotedFile: string | null;
  apply: string | null;
  tokens: number;
  wallMs: number;
  models: string[];
  redteam: string | null;
}

function armView(arm: TrainingRecord["arms"]["baseline"]): TrainingArmView {
  return {
    source: arm.source,
    mean: arm.score.mean,
    lower: arm.score.lower,
    upper: arm.score.upper,
    n: arm.score.n,
    errored: arm.errored,
  };
}

function changeLabel(record: TrainingRecord): string {
  const { prompt, playbook } = record.change;
  if (prompt !== null) return `${prompt.name} v${prompt.from} → v${prompt.to}`;
  if (playbook !== null)
    return `house playbook ${playbook.key} v${playbook.from} → v${playbook.to} (${playbook.entries} ${playbook.entries === 1 ? "entry" : "entries"})`;
  return record.kind === "prompt" ? "no prompt candidate" : "no playbook candidate";
}

function deltaOf(record: TrainingRecord): TrainingDelta | null {
  const { paired, welch } = record.comparison;
  if (paired !== null)
    return {
      kind: "paired",
      value: paired.delta,
      lower: paired.lower,
      upper: paired.upper,
      pValue: paired.pValue,
      units: `${paired.cases} cases`,
    };
  if (welch !== null)
    return {
      kind: "pooled",
      value: welch.delta,
      lower: null,
      upper: null,
      pValue: welch.pValue,
      units: "pooled trials",
    };
  return null;
}

export function trainingRows(records: readonly TrainingRecord[]): TrainingRow[] {
  return [...records]
    .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt) || b.id.localeCompare(a.id))
    .map((record) => ({
      id: record.id,
      mission: record.mission,
      title: EVAL_MISSION_INFO[record.mission].title,
      round: record.round,
      kind: record.kind,
      finishedAt: record.finishedAt,
      status: record.decision.status,
      change: changeLabel(record),
      baseline: armView(record.arms.baseline),
      candidate: record.arms.candidate === null ? null : armView(record.arms.candidate),
      delta: deltaOf(record),
      alpha: record.comparison.alpha,
      comparisons: record.comparison.comparisons,
      reasons: record.decision.reasons,
      promotedFile: record.promotion?.file ?? null,
      apply: record.promotion?.apply ?? null,
      tokens: record.tokens,
      wallMs: record.wallMs,
      models: record.models.map(
        (entry) => `${entry.role} ${entry.provider}/${entry.model} ×${entry.calls}`,
      ),
      redteam:
        record.redteam === null
          ? null
          : `${record.redteam.successes}/${record.redteam.attacks} attacks succeeded`,
    }));
}

export interface LineageStep {
  from: number;
  to: number;
  recordId: string;
  finishedAt: string;
}

export interface MissionLineage {
  mission: EvalMission;
  title: string;
  steps: number;
  promoted: number;
  prompts: { name: string; steps: LineageStep[] }[];
  playbooks: { key: string; steps: LineageStep[] }[];
}

export function trainingLineage(records: readonly TrainingRecord[]): MissionLineage[] {
  return EVAL_MISSIONS.map((mission) => {
    const own = records
      .filter((record) => record.mission === mission)
      .sort((a, b) => a.finishedAt.localeCompare(b.finishedAt) || a.id.localeCompare(b.id));
    const promoted = own.filter((record) => record.decision.status === "promoted");
    const prompts = new Map<string, LineageStep[]>();
    const playbooks = new Map<string, LineageStep[]>();
    for (const record of promoted) {
      const step = { recordId: record.id, finishedAt: record.finishedAt };
      const { prompt, playbook } = record.change;
      if (prompt !== null)
        prompts.set(prompt.name, [
          ...(prompts.get(prompt.name) ?? []),
          { from: prompt.from, to: prompt.to, ...step },
        ]);
      if (playbook !== null)
        playbooks.set(playbook.key, [
          ...(playbooks.get(playbook.key) ?? []),
          { from: playbook.from, to: playbook.to, ...step },
        ]);
    }
    return {
      mission,
      title: EVAL_MISSION_INFO[mission].title,
      steps: own.length,
      promoted: promoted.length,
      prompts: [...prompts.entries()].map(([name, steps]) => ({ name, steps })),
      playbooks: [...playbooks.entries()].map(([key, steps]) => ({ key, steps })),
    };
  });
}

export interface PromptCatalogEntry {
  name: string;
  version: number;
  status: string;
}

export function loadPromptCatalog(promptsDir: string): PromptCatalogEntry[] {
  if (!existsSync(promptsDir)) return [];
  return readdirSync(promptsDir)
    .filter((entry) => /\.v\d+\.md$/.test(entry))
    .sort()
    .flatMap((entry) => {
      try {
        const prompt = parsePromptFile(entry, readFileSync(path.join(promptsDir, entry), "utf8"));
        return [{ name: prompt.name, version: prompt.version, status: prompt.status }];
      } catch {
        return [];
      }
    });
}

export interface HousePlaybookEntry {
  key: string;
  version: number;
  entries: number;
  runs: number;
}

export function loadHousePlaybooks(playbooksDir: string): HousePlaybookEntry[] {
  if (!existsSync(playbooksDir)) return [];
  return readdirSync(playbooksDir)
    .sort()
    .flatMap((entry) => {
      const key = housePlaybookKeyOfFile(entry);
      if (key === undefined) return [];
      try {
        const playbook = parseHousePlaybook(
          key,
          readFileSync(path.join(playbooksDir, entry), "utf8"),
        );
        return playbook === null
          ? []
          : [
              {
                key,
                version: playbook.version,
                entries: playbook.entries.length,
                runs: playbook.runs,
              },
            ];
      } catch {
        return [];
      }
    });
}

export interface LivePrompt {
  key: string;
  name: string;
  file: string;
  liveVersion: number | null;
  onDisk: number[];
  trainable: boolean;
  awaitingPointer: number | null;
}

export interface MissionPrompts {
  mission: EvalMission;
  title: string;
  prompts: LivePrompt[];
  playbooks: HousePlaybookEntry[];
}

const PROMPT_FILE_NAME = /^(.+)\.v(\d+)\.md$/;

export function livePromptVersions(input: {
  catalog: readonly PromptCatalogEntry[];
  records: readonly TrainingRecord[];
  playbooks: readonly HousePlaybookEntry[];
  promptFiles?: Readonly<Record<string, string>>;
}): MissionPrompts[] {
  const files: Readonly<Partial<Record<string, string>>> =
    input.promptFiles ?? RUNTIME_PROMPT_FILES;
  return EVAL_MISSIONS.map((mission) => {
    const targets = MISSION_TARGETS[mission];
    const trainable = new Set<string>(targets.prompts);
    const prompts = targets.runtimePrompts.flatMap((key): LivePrompt[] => {
      const file = files[key];
      const match = file === undefined ? null : PROMPT_FILE_NAME.exec(file);
      if (file === undefined || match?.[1] === undefined) return [];
      const name = match[1];
      const pointed = Number(match[2]);
      const onDisk = input.catalog
        .filter((entry) => entry.name === name)
        .map((entry) => entry.version)
        .sort((a, b) => a - b);
      const promoted = input.records
        .flatMap((record) =>
          record.mission === mission &&
          record.decision.status === "promoted" &&
          record.change.prompt?.name === name
            ? [record.change.prompt.to]
            : [],
        )
        .filter((version) => version > pointed && onDisk.includes(version));
      return [
        {
          key,
          name,
          file,
          liveVersion: onDisk.includes(pointed) ? pointed : null,
          onDisk,
          trainable: trainable.has(key),
          awaitingPointer: promoted.length === 0 ? null : Math.max(...promoted),
        },
      ];
    });
    return {
      mission,
      title: EVAL_MISSION_INFO[mission].title,
      prompts,
      playbooks: input.playbooks.filter(
        (entry) => entry.key.split(":")[0] === targets.runtimeMissionId,
      ),
    };
  });
}

export type RoutingState =
  { status: "absent" } | { status: "invalid" } | { status: "ok"; routing: LearnedRouting };

export function loadLearnedRouting(file: string): RoutingState {
  if (!existsSync(file)) return { status: "absent" };
  try {
    const parsed = LearnedRoutingSchema.safeParse(
      JSON.parse(readFileSync(file, "utf8")) as unknown,
    );
    return parsed.success ? { status: "ok", routing: parsed.data } : { status: "invalid" };
  } catch {
    return { status: "invalid" };
  }
}

export interface EvalsLearning {
  training: { rows: TrainingRow[]; lineage: MissionLineage[]; invalid: string[] };
  prompts: MissionPrompts[];
  routing: RoutingState;
}

export function loadEvalsLearning(repoRoot: string = resolveRepoRoot()): EvalsLearning {
  const training = loadTraining(path.join(repoRoot, "packages", "evals", "results", "training"));
  const playbooks = loadHousePlaybooks(path.join(repoRoot, "packages", "runtime", "playbooks"));
  return {
    training: {
      rows: trainingRows(training.records),
      lineage: trainingLineage(training.records),
      invalid: training.invalid,
    },
    prompts: livePromptVersions({
      catalog: loadPromptCatalog(path.join(repoRoot, "packages", "runtime", "prompts")),
      records: training.records,
      playbooks,
    }),
    routing: loadLearnedRouting(path.join(repoRoot, "config", "routing.learned.json")),
  };
}
