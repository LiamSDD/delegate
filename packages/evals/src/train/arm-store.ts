import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  PlaybookSchema,
  playbookKey,
  rebuildPlaybook,
  type LoggedRun,
  type Playbook,
  type PromptFile,
} from "@delegate/runtime";
import { z } from "zod";

import { parseEventLog } from "../event-log";
import {
  ArmRowSchema,
  ArmServingSchema,
  gradedRows,
  mergeServing,
  type ArmRow,
  type ArmServing,
  type Houses,
} from "../evolve/arm";
import { runDir, trialFile } from "../judge/agreement-store";
import { type BaseCase, type MissionAdapter } from "../missions/adapter";
import { EvalResultFileSchema, type EvalMission, type EvalResultFile } from "../results";
import { meanConfidenceInterval, wilsonInterval } from "../stats";
import { type ArmReport } from "./record";

export const ARM_FILE_VERSION = 1;
export const ARM_LIMITS = { maxErroredShare: 0.25, minGradedPerCase: 2 } as const;

const versionAndHash = z.strictObject({
  version: z.number().int().nonnegative(),
  sha: z.string().regex(/^[0-9a-f]{12}$/),
});

export const ArmConfigSchema = z.strictObject({
  mission: z.string().min(1),
  dataset: z.strictObject({ name: z.string().min(1), version: z.number().int().positive() }),
  cases: z.array(z.string().min(1)).min(1),
  trials: z.number().int().positive(),
  audience: z.enum(["public-demo", "owner"]),
  prompts: z.record(z.string().min(1), versionAndHash),
  playbooks: z.record(z.string().min(1), versionAndHash),
});
export type ArmConfig = z.infer<typeof ArmConfigSchema>;

export const ArmFileSchema = z.strictObject({
  version: z.literal(ARM_FILE_VERSION),
  fingerprint: z.string().regex(/^[0-9a-f]{16}$/),
  source: z.enum(["run", "result"]),
  config: ArmConfigSchema,
  evalRun: z.string().min(1),
  startedAt: z.iso.datetime({ offset: true }),
  finishedAt: z.iso.datetime({ offset: true }),
  wallMs: z.number().int().nonnegative(),
  rows: z.array(ArmRowSchema),
  models: z.array(ArmServingSchema),
  pool: z.array(PlaybookSchema),
});
export type ArmFile = z.infer<typeof ArmFileSchema>;

function sha(text: string, length: number): string {
  return createHash("sha256").update(text).digest("hex").slice(0, length);
}

export function promptSlug(name: string): string {
  return name.replace(/[^a-z0-9-]+/g, "-");
}

function sorted<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

export function armConfig(input: {
  mission: EvalMission;
  dataset: { name: string; version: number };
  cases: readonly string[];
  trials: number;
  audience: "public-demo" | "owner";
  prompts: readonly PromptFile[];
  houses: Houses;
}): ArmConfig {
  return ArmConfigSchema.parse({
    mission: input.mission,
    dataset: { name: input.dataset.name, version: input.dataset.version },
    cases: [...input.cases].sort(),
    trials: input.trials,
    audience: input.audience,
    prompts: sorted(
      Object.fromEntries(
        input.prompts.map((prompt) => [
          promptSlug(prompt.name),
          { version: prompt.version, sha: sha(prompt.body, 12) },
        ]),
      ),
    ),
    playbooks: sorted(
      Object.fromEntries(
        Object.entries(input.houses).flatMap(([key, house]) =>
          house === null || house.entries.length === 0
            ? []
            : [[key, { version: house.version, sha: sha(JSON.stringify(house.entries), 12) }]],
        ),
      ),
    ),
  });
}

export function armFingerprint(config: ArmConfig): string {
  return sha(JSON.stringify(config), 16);
}

export function armPath(trainingDir: string, mission: string, fingerprint: string): string {
  return join(trainingDir, "arms", mission, `${fingerprint}.json`);
}

export function readArm(trainingDir: string, mission: string, fingerprint: string): ArmFile | null {
  const path = armPath(trainingDir, mission, fingerprint);
  if (!existsSync(path)) return null;
  try {
    const parsed = ArmFileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")) as unknown);
    return parsed.success && parsed.data.fingerprint === fingerprint ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeArm(trainingDir: string, arm: ArmFile): string {
  const path = armPath(trainingDir, arm.config.mission, arm.fingerprint);
  mkdirSync(join(trainingDir, "arms", arm.config.mission), { recursive: true });
  writeFileSync(path, `${JSON.stringify(ArmFileSchema.parse(arm), null, 2)}\n`);
  return path;
}

export function listArms(trainingDir: string, mission: string): ArmFile[] {
  const dir = join(trainingDir, "arms", mission);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .flatMap((entry) => {
      const arm = readArm(trainingDir, mission, entry.slice(0, -".json".length));
      return arm === null ? [] : [arm];
    });
}

export function armProblems(config: ArmConfig, rows: readonly ArmRow[]): string[] {
  const problems: string[] = [];
  const errored = rows.length - gradedRows(rows).length;
  if (rows.length === 0) problems.push("the arm produced no trials");
  else if (errored / rows.length > ARM_LIMITS.maxErroredShare)
    problems.push(
      `${errored} of ${rows.length} trials errored on infrastructure (limit ${Math.round(ARM_LIMITS.maxErroredShare * 100)}%)`,
    );
  const thin = config.cases.filter(
    (caseId) =>
      gradedRows(rows).filter((row) => row.caseId === caseId).length < ARM_LIMITS.minGradedPerCase,
  );
  if (thin.length > 0)
    problems.push(
      `fewer than ${ARM_LIMITS.minGradedPerCase} graded trials for ${thin.length === 1 ? "case" : "cases"} ${thin.join(", ")}`,
    );
  return problems;
}

export function armReport(arm: ArmFile, source: ArmReport["source"]): ArmReport {
  const graded = gradedRows(arm.rows);
  const scores = graded.map((row) => row.score);
  const interval = scores.length >= 2 ? meanConfidenceInterval(scores) : undefined;
  const passes = graded.filter((row) => row.passed).length;
  const wilson = graded.length === 0 ? null : wilsonInterval(passes, graded.length);
  return {
    fingerprint: arm.fingerprint,
    source,
    evalRun: arm.evalRun,
    trials: arm.rows.length,
    graded: graded.length,
    errored: arm.rows.length - graded.length,
    score: {
      mean:
        scores.length === 0 ? null : scores.reduce((sum, value) => sum + value, 0) / scores.length,
      lower: interval === undefined ? null : Math.max(0, interval.lower),
      upper: interval === undefined ? null : Math.min(1, interval.upper),
      n: scores.length,
    },
    passRate:
      wilson === null
        ? null
        : { rate: wilson.rate, lower: wilson.lower, upper: wilson.upper, n: wilson.n },
    hardFailures: graded.filter((row) => row.hardFailures.length > 0).length,
    tokens: arm.rows.reduce((sum, row) => sum + row.tokens, 0),
    wallMs: arm.wallMs,
    models: arm.models,
  };
}

function sameVersions(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => a[key] === b[key]);
}

export type ReuseVerdict =
  { reusable: true; file: EvalResultFile; rows: ArmRow[] } | { reusable: false; reason: string };

export function reuseVerdict(file: EvalResultFile, config: ArmConfig): ReuseVerdict {
  const no = (reason: string): ReuseVerdict => ({ reusable: false, reason });
  if (file.mode !== "live") return no("it is a replay");
  if (file.audience !== config.audience) return no(`audience is ${file.audience}`);
  if (file.dataset.name !== config.dataset.name || file.dataset.version !== config.dataset.version)
    return no(`dataset is ${file.dataset.name} v${file.dataset.version}`);
  const wanted = Object.fromEntries(
    Object.entries(config.prompts).map(([name, entry]) => [name, entry.version]),
  );
  if (!sameVersions(file.promptVersions, wanted)) return no("prompt versions differ");
  const rows: ArmRow[] = [];
  for (const caseId of config.cases) {
    const entry = file.cases.find((row) => row.caseId === caseId);
    const trials = [...(entry?.trials ?? [])].sort((a, b) => a.trial - b.trial);
    if (trials.length < config.trials)
      return no(`case ${caseId} has ${trials.length} of ${config.trials} trials`);
    for (const trial of trials.slice(0, config.trials)) {
      if (trial.hardFailures === undefined)
        return no("it predates per-trial hard failures, so a new hard failure could not be told");
      rows.push({
        caseId,
        trial: trial.trial,
        runId: trial.runId,
        outcome: trial.outcome,
        ...(trial.failureCode === undefined ? {} : { failureCode: trial.failureCode }),
        passed: trial.passed,
        score: trial.score,
        hardFailures: trial.hardFailures,
        tokens: trial.tokens,
        latencyMs: trial.latencyMs,
        serving: trial.serving ?? [],
      });
    }
  }
  return { reusable: true, file, rows };
}

export function loadResultFiles(resultsDir: string, mission: EvalMission): EvalResultFile[] {
  const dir = join(resultsDir, mission);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".json"))
    .flatMap((entry) => {
      try {
        const parsed = EvalResultFileSchema.safeParse(
          JSON.parse(readFileSync(join(dir, entry), "utf8")) as unknown,
        );
        return parsed.success && parsed.data.mission === mission ? [parsed.data] : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));
}

export function findReusableResult(
  resultsDir: string,
  mission: EvalMission,
  config: ArmConfig,
): { match?: { file: EvalResultFile; rows: ArmRow[] }; latestReason?: string } {
  if (Object.keys(config.playbooks).length > 0)
    return { latestReason: "the parent has a house playbook, which plain eval runs do not apply" };
  let latestReason: string | undefined;
  for (const file of loadResultFiles(resultsDir, mission)) {
    const verdict = reuseVerdict(file, config);
    if (verdict.reusable) return { match: { file: verdict.file, rows: verdict.rows } };
    latestReason ??= `latest result ${file.id} is not reusable: ${verdict.reason}`;
  }
  return latestReason === undefined ? {} : { latestReason };
}

export function armFromResult(
  config: ArmConfig,
  match: { file: EvalResultFile; rows: ArmRow[] },
  pool: Playbook[],
): ArmFile {
  const perTrial =
    match.file.totals.trials === 0 ? 0 : match.file.durationMs / match.file.totals.trials;
  const trialServing = mergeServing(match.rows.map((row) => row.serving));
  return {
    version: ARM_FILE_VERSION,
    fingerprint: armFingerprint(config),
    source: "result",
    config,
    evalRun: match.file.id,
    startedAt: match.file.startedAt,
    finishedAt: match.file.finishedAt,
    wallMs: Math.round(perTrial * match.rows.length),
    rows: match.rows,
    models: trialServing.length > 0 ? trialServing : mergeServing([match.file.models]),
    pool,
  };
}

export function poolFromRunDir<C extends BaseCase, X>(
  adapter: MissionAdapter<C, X>,
  dir: string,
  rows: readonly ArmRow[],
): Playbook[] {
  if (!existsSync(dir)) return [];
  const inputs = new Map(adapter.loadCases().map((c) => [c.id, adapter.input(c)]));
  const byKey = new Map<string, LoggedRun[]>();
  for (const row of [...gradedRows(rows)].sort(
    (a, b) => a.caseId.localeCompare(b.caseId) || a.trial - b.trial,
  )) {
    const input = inputs.get(row.caseId);
    const path = trialFile(dir, row.caseId, row.trial, "events.jsonl");
    if (input === undefined || !existsSync(path)) continue;
    let events: LoggedRun["events"];
    try {
      events = parseEventLog(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    const key = playbookKey(adapter.runtimeMissionId, input);
    const run: LoggedRun = {
      runId: row.runId,
      frame: { missionId: adapter.runtimeMissionId, input },
      events,
      graderScore: row.score,
    };
    byKey.set(key, [...(byKey.get(key) ?? []), run]);
  }
  return [...byKey.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([key, runs]) => {
      const playbook = rebuildPlaybook(key, "house", runs);
      return playbook === null || playbook.entries.length === 0 ? [] : [playbook];
    });
}

export function storedRunDir(resultsDir: string, mission: EvalMission, evalRun: string): string {
  return runDir(resultsDir, mission, evalRun);
}

export function observedTrialMs(
  trainingDir: string,
  resultsDir: string,
  mission: EvalMission,
): number | undefined {
  const fromArms = listArms(trainingDir, mission)
    .filter((arm) => arm.source === "run" && arm.rows.length > 0)
    .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))
    .slice(0, 3)
    .map((arm) => arm.wallMs / arm.rows.length);
  const fromResults = loadResultFiles(resultsDir, mission)
    .filter((file) => file.mode === "live" && file.totals.trials > 0)
    .slice(0, 3)
    .map((file) => file.durationMs / file.totals.trials);
  const observed = [...fromArms, ...fromResults];
  return observed.length === 0 ? undefined : Math.max(...observed);
}

export function modelsOf(rows: readonly ArmRow[]): ArmServing[] {
  return mergeServing(rows.map((row) => row.serving));
}
