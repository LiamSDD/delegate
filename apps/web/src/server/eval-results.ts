import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import {
  EvalResultFileSchema,
  paretoFrontier,
  scoreboard,
  type EvalResultFile,
  type ResultAgreement,
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

export interface LoadedResults {
  files: EvalResultFile[];
  invalid: string[];
}

export interface MissionScore {
  mission: string;
  latest: EvalResultFile;
  board: ResultScoreboard;
  runs: number;
}

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

export interface Calibration {
  mission: string;
  resultId: string;
  agreement: ResultAgreement;
}

export interface EvalsDashboard {
  missions: MissionScore[];
  frontier: FrontierPoint[];
  calibration: Calibration[];
  invalid: string[];
}

export function evalResultsDir(): string {
  return path.join(resolveRepoRoot(), "packages", "evals", "results");
}

function isRunDirectory(dir: string): boolean {
  return existsSync(path.join(dir, "summary.json"));
}

export function loadEvalResults(resultsDir: string): LoadedResults {
  if (!existsSync(resultsDir)) return { files: [], invalid: [] };
  const files: EvalResultFile[] = [];
  const invalid: string[] = [];
  for (const name of readdirSync(resultsDir).sort()) {
    const dir = path.join(resultsDir, name);
    if (!statSync(dir).isDirectory() || isRunDirectory(dir)) continue;
    for (const entry of readdirSync(dir).sort()) {
      if (!entry.endsWith(".json")) continue;
      const relative = `${name}/${entry}`;
      try {
        const parsed = EvalResultFileSchema.safeParse(
          JSON.parse(readFileSync(path.join(dir, entry), "utf8")) as unknown,
        );
        if (parsed.success && parsed.data.mission === name) files.push(parsed.data);
        else invalid.push(relative);
      } catch {
        invalid.push(relative);
      }
    }
  }
  return { files, invalid };
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

export function buildDashboard(loaded: LoadedResults): EvalsDashboard {
  const byMission = new Map<string, EvalResultFile[]>();
  for (const file of loaded.files) {
    byMission.set(file.mission, [...(byMission.get(file.mission) ?? []), file]);
  }
  const missions: MissionScore[] = [];
  const calibration: Calibration[] = [];
  for (const [mission, files] of [...byMission].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = [...files].sort((a, b) => a.finishedAt.localeCompare(b.finishedAt));
    const latest = sorted.at(-1);
    if (latest === undefined) continue;
    missions.push({ mission, latest, board: scoreboard(latest), runs: files.length });
    const labelled = [...sorted]
      .reverse()
      .find((file) => file.agreement.status !== "no_human_labels");
    calibration.push({
      mission,
      resultId: (labelled ?? latest).id,
      agreement: (labelled ?? latest).agreement,
    });
  }
  const candidates = loaded.files.flatMap((file) => {
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
  const frontier = new Set<string>();
  for (const mission of new Set(candidates.map((point) => point.mission))) {
    const ids = paretoFrontier(
      candidates
        .filter((point) => point.mission === mission)
        .map((point) => ({ id: point.id, cost: point.tokensPerTrial, quality: point.passRate })),
    );
    for (const id of ids) frontier.add(id);
  }
  return {
    missions,
    frontier: candidates.map((point) => ({ ...point, onFrontier: frontier.has(point.id) })),
    calibration,
    invalid: loaded.invalid,
  };
}
