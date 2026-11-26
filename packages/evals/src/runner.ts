import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type RunEvent } from "@delegate/runtime";
import {
  RUN_BUDGETS,
  loadRuntimePrompts,
  type RunMissionOptions,
  type RunMissionResult,
  type RuntimePrompts,
} from "@delegate/runtime/server";
import { z } from "zod";

import { selectById } from "./datasets/jsonl";
import { createMemorySink, parseEventLog, serialiseEventLog } from "./event-log";
import { type LinkStatus } from "./graders/xray";
import {
  checkScore,
  type BudgetTargets,
  type GradedCheck,
  type RunMetrics,
  type ServingRecord,
} from "./graders/run-metrics";
import {
  JudgeRecordSchema,
  latestRunDir,
  missionAgreement,
  readJudgeRecord,
  runDir,
  toResultAgreement,
  trialFile,
  type JudgeRecord,
} from "./judge/agreement-store";
import { renderAgreement, type AgreementReport } from "./judge/calibration";
import {
  loadEvalPrompt,
  normaliseScores,
  runJudge,
  verdictScores,
  type JudgeCompleter,
} from "./judge/rubric-judge";
import {
  targetsFor,
  type AnswerRequest,
  type BaseCase,
  type EvalMission,
  type MissionAdapter,
  type MissionGrade,
  type QuestionAnswer,
} from "./missions/adapter";
import { missionAdapter } from "./missions";
import {
  EVAL_RESULT_FILE_VERSION,
  EvalResultFileSchema,
  type EvalResultFile,
  type ResultMetric,
} from "./results";
import { compareScores, mean, meanConfidenceInterval, wilsonInterval } from "./stats";
import { summariseTrials, type Trial } from "./types";

export const RETRYABLE_FAILURES: readonly string[] = ["no_model_available"];
export const RETRY_BACKOFF_MS = 60_000;
export const MAX_RETRY_WAIT_MS = 600_000;
export const MAX_RETRIES = 2;

export interface RunEvalOptions {
  mission?: EvalMission;
  trials: number;
  caseIds?: string[];
  tag?: string;
  audience: "public-demo" | "owner";
  offline: boolean;
  replayDir?: string;
  concurrency: number;
  baseline: boolean;
  judge: boolean;
  resultsDir: string;
  threshold: number;
  datasetFile?: string;
  prompts?: Partial<RuntimePrompts>;
}

export interface SharedCooldown {
  wait(): Promise<void>;
  pause(ms: number): Promise<void>;
  until(): number;
}

export function createSharedCooldown(
  sleep: (ms: number) => Promise<void>,
  now: () => Date,
): SharedCooldown {
  let pending: Promise<void> = Promise.resolve();
  let until = 0;
  return {
    wait: () => pending,
    pause: (ms) => {
      until = Math.max(until, now().getTime() + ms);
      pending = Promise.all([pending, sleep(ms)]).then(() => undefined);
      return pending;
    },
    until: () => until,
  };
}

export interface RunEvalDeps {
  runMission: (options: RunMissionOptions) => Promise<RunMissionResult>;
  env: Record<string, string | undefined>;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  judgeCompleter?: JudgeCompleter;
  checkLinks?: (urls: readonly string[]) => Promise<Map<string, LinkStatus>>;
  answerQuestion?: (request: AnswerRequest) => Promise<QuestionAnswer>;
  log: (line: string) => void;
  onTrial?: (record: TrialRecord) => void;
  cooldown?: SharedCooldown;
}

export interface TrialRecord {
  caseId: string;
  trial: number;
  runId: string;
  startedAt: string;
  outcome: MissionGrade["outcome"];
  failureCode?: string;
  retries: number;
  passed: boolean;
  score: number;
  hardFailures: string[];
  checks: GradedCheck[];
  metrics: RunMetrics;
  missionMetrics: Record<string, number>;
  citationsVerified: boolean | null;
  serving: ServingRecord[];
  judge?: JudgeRecord & { scores: Record<string, number> };
  judgeError?: string;
}

export interface Interval {
  mean: number;
  lower: number | null;
  upper: number | null;
  n: number;
}

export interface CaseSummary {
  caseId: string;
  company: string;
  trials: number;
  passRate: { rate: number; lower: number; upper: number; n: number };
  score: Interval;
  judge: Partial<Record<string, Interval>>;
  missionMetrics: Record<string, Interval>;
  p50LatencyMs: number;
  meanCostMicroUsd: number;
  hardFailures: number;
  errored: number;
  failureCodes: Record<string, number>;
  usedSummariseTrials: boolean;
}

export interface Comparison {
  scope: string;
  metric: "score" | "judge" | "cost";
  status: "compared" | "insufficient_data";
  baselineN: number;
  candidateN: number;
  baselineMean?: number;
  candidateMean?: number;
  worsening?: number;
  threshold?: number;
  pValue?: number;
  regression: boolean;
}

export interface EvalSummary {
  id: string;
  mode: "live" | "replay";
  replayOf?: string;
  mission: EvalMission;
  title: string;
  dataset: { name: string; version: number };
  audience: RunEvalOptions["audience"];
  startedAt: string;
  finishedAt: string;
  trialsPerCase: number;
  promptVersions: Record<string, number>;
  serving: ServingRecord[];
  judgeServing: { provider: string; model: string; calls: number }[];
  judgeCriteria: string[];
  targets: BudgetTargets;
  cases: CaseSummary[];
  overall: {
    trials: number;
    passRate: { rate: number; lower: number; upper: number; n: number };
    score: Interval;
    judge: Partial<Record<string, Interval>>;
    missionMetrics: Record<string, Interval>;
    p50LatencyMs: number;
    p95LatencyMs: number;
    totalCostMicroUsd: number;
    hardFailures: number;
    errored: number;
    retries: number;
    checkPassRates: Record<string, { passed: number; counted: number }>;
    trajectory: {
      toolCalls: number;
      redundantFetches: number;
      policyDenials: number;
      injectionFlags: number;
      fallbacks: number;
    };
  };
  comparisons: Comparison[];
  regressions: Comparison[];
  agreement: AgreementReport;
}

const BaselineSchema = z.object({
  summaryId: z.string(),
  dataset: z.object({ name: z.string(), version: z.number() }),
  createdAt: z.string(),
  promptVersions: z.record(z.string(), z.number()),
  cases: z.record(
    z.string(),
    z.object({
      scores: z.array(z.number()),
      judge: z.array(z.number()),
      cost: z.array(z.number()),
    }),
  ),
});
type Baseline = z.infer<typeof BaselineSchema>;

function promptSlug(name: string): string {
  return name.replace(/[^a-z0-9-]+/g, "-");
}

export function missionPromptVersions(
  adapter: MissionAdapter,
  overrides: Partial<RuntimePrompts> = {},
): Record<string, number> {
  const runtime = loadRuntimePrompts(overrides);
  const prompts = [
    ...adapter.runtimePrompts.map((key) => runtime[key]),
    loadEvalPrompt(adapter.judge.promptFile),
  ];
  return Object.fromEntries(prompts.map((prompt) => [promptSlug(prompt.name), prompt.version]));
}

function stamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[rank] ?? 0;
}

function interval(values: readonly number[], clamp = true): Interval | undefined {
  if (values.length === 0) return undefined;
  if (values.length === 1) return { mean: values[0] ?? 0, lower: null, upper: null, n: 1 };
  const ci = meanConfidenceInterval(values);
  return {
    mean: ci.mean,
    lower: clamp ? Math.max(0, ci.lower) : ci.lower,
    upper: clamp ? Math.min(1, ci.upper) : ci.upper,
    n: ci.n,
  };
}

function judgeIntervals(records: readonly TrialRecord[], criteria: readonly string[]) {
  const judged = records.flatMap((record) =>
    record.judge === undefined ? [] : [record.judge.scores],
  );
  const result: Partial<Record<string, Interval>> = {};
  for (const criterion of criteria) {
    const value = interval(
      judged.flatMap((scores) => (scores[criterion] === undefined ? [] : [scores[criterion]])),
    );
    if (value !== undefined) result[criterion] = value;
  }
  const overall = interval(judged.map((scores) => mean(criteria.map((c) => scores[c] ?? 0))));
  if (overall !== undefined) result.overall = overall;
  return result;
}

function metricIntervals(records: readonly TrialRecord[]): Record<string, Interval> {
  const names = [
    ...new Set(records.flatMap((record) => Object.keys(record.missionMetrics))),
  ].sort();
  const result: Record<string, Interval> = {};
  for (const name of names) {
    const value = interval(
      records.flatMap((record) => {
        const metric = record.missionMetrics[name];
        return metric === undefined || record.outcome === "errored" ? [] : [metric];
      }),
      false,
    );
    if (value !== undefined) result[name] = value;
  }
  return result;
}

function judgeMean(record: TrialRecord, criteria: readonly string[]): number | undefined {
  return record.judge === undefined
    ? undefined
    : mean(criteria.map((criterion) => record.judge?.scores[criterion] ?? 0));
}

function toTrial(record: TrialRecord, mission: string, versions: Record<string, number>): Trial {
  return {
    caseId: record.caseId,
    mission,
    trialIndex: record.trial,
    runId: record.runId,
    promptVersions: versions,
    serving: record.serving,
    startedAt: record.startedAt,
    latencyMs: record.metrics.latencyMs,
    costMicroUsd: record.metrics.costMicroUsd,
    score: record.score,
    passed: record.passed,
    checks: record.checks.map((entry) => ({
      kind: entry.kind,
      passed: entry.passed,
      ...(entry.detail === undefined ? {} : { detail: entry.detail }),
    })),
    ...(record.judge === undefined
      ? {}
      : {
          judge: {
            provider: record.judge.provider,
            model: record.judge.model,
            promptVersion: record.judge.promptVersion,
            scores: record.judge.scores,
          },
        }),
  };
}

function summariseCase(
  caseId: string,
  subject: string,
  mission: string,
  records: readonly TrialRecord[],
  versions: Record<string, number>,
  criteria: readonly string[],
): CaseSummary {
  const failureCodes: Record<string, number> = {};
  for (const record of records) {
    if (record.failureCode !== undefined)
      failureCodes[record.failureCode] = (failureCodes[record.failureCode] ?? 0) + 1;
  }
  const base = {
    caseId,
    company: subject,
    trials: records.length,
    judge: judgeIntervals(records, criteria),
    missionMetrics: metricIntervals(records),
    hardFailures: records.filter((record) => record.hardFailures.length > 0).length,
    errored: records.filter((record) => record.outcome === "errored").length,
    failureCodes,
  };
  const summarisable = records.length >= 2 && records.every((record) => record.serving.length > 0);
  if (summarisable) {
    const result = summariseTrials(records.map((record) => toTrial(record, mission, versions)));
    return {
      ...base,
      passRate: result.passRate,
      score: {
        mean: result.score.mean,
        lower: result.score.lower,
        upper: result.score.upper,
        n: result.score.n,
      },
      p50LatencyMs: result.p50LatencyMs,
      meanCostMicroUsd: result.meanCostMicroUsd,
      usedSummariseTrials: true,
    };
  }
  return {
    ...base,
    passRate: wilsonInterval(records.filter((record) => record.passed).length, records.length),
    score: interval(records.map((record) => record.score)) ?? {
      mean: 0,
      lower: null,
      upper: null,
      n: 0,
    },
    p50LatencyMs: percentile(
      records.map((record) => record.metrics.latencyMs),
      0.5,
    ),
    meanCostMicroUsd: mean(records.map((record) => record.metrics.costMicroUsd)),
    usedSummariseTrials: false,
  };
}

function mergeServing(records: readonly TrialRecord[]): ServingRecord[] {
  const merged = new Map<string, ServingRecord>();
  for (const entry of records.flatMap((record) => record.serving)) {
    const key = `${entry.role}\u0000${entry.provider}\u0000${entry.model}`;
    const existing = merged.get(key);
    merged.set(
      key,
      existing === undefined ? { ...entry } : { ...existing, calls: existing.calls + entry.calls },
    );
  }
  return [...merged.values()];
}

function compare(
  scope: string,
  metric: Comparison["metric"],
  baseline: readonly number[],
  candidate: readonly number[],
  threshold: number,
  higherIsBetter = true,
): Comparison {
  if (baseline.length < 2 || candidate.length < 2)
    return {
      scope,
      metric,
      status: "insufficient_data",
      baselineN: baseline.length,
      candidateN: candidate.length,
      regression: false,
    };
  const result = compareScores(baseline, candidate, threshold, { higherIsBetter });
  return {
    scope,
    metric,
    status: "compared",
    baselineN: baseline.length,
    candidateN: candidate.length,
    baselineMean: result.baselineMean,
    candidateMean: result.candidateMean,
    worsening: result.worsening,
    threshold,
    pValue: result.pValue,
    regression: result.regression,
  };
}

function compareToBaseline(
  baseline: Baseline | undefined,
  datasetVersion: number,
  byCase: ReadonlyMap<string, TrialRecord[]>,
  threshold: number,
  criteria: readonly string[],
): Comparison[] {
  if (baseline?.dataset.version !== datasetVersion) return [];
  const comparisons: Comparison[] = [];
  const overall = {
    score: [[], []] as number[][],
    judge: [[], []] as number[][],
    cost: [[], []] as number[][],
  };
  for (const [caseId, records] of byCase) {
    const base = baseline.cases[caseId];
    if (base === undefined) continue;
    const scores = records.map((record) => record.score);
    const judge = records.flatMap((record) => {
      const value = judgeMean(record, criteria);
      return value === undefined ? [] : [value];
    });
    const cost = records.map((record) => record.metrics.costMicroUsd);
    comparisons.push(compare(caseId, "score", base.scores, scores, threshold));
    overall.score[0]?.push(...base.scores);
    overall.score[1]?.push(...scores);
    overall.judge[0]?.push(...base.judge);
    overall.judge[1]?.push(...judge);
    overall.cost[0]?.push(...base.cost);
    overall.cost[1]?.push(...cost);
  }
  const [baseScores = [], candScores = []] = overall.score;
  const [baseJudge = [], candJudge = []] = overall.judge;
  const [baseCost = [], candCost = []] = overall.cost;
  comparisons.unshift(
    compare("overall", "score", baseScores, candScores, threshold),
    compare("overall", "judge", baseJudge, candJudge, threshold),
    compare(
      "overall",
      "cost",
      baseCost,
      candCost,
      Math.max(1, 0.2 * (baseCost.length === 0 ? 0 : mean(baseCost))),
      false,
    ),
  );
  return comparisons;
}

function loadBaseline(path: string): Baseline | undefined {
  if (!existsSync(path)) return undefined;
  return BaselineSchema.parse(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

export function baselinePath(resultsDir: string, mission: EvalMission): string {
  return join(resultsDir, mission === "xray" ? "baseline.json" : `baseline.${mission}.json`);
}

export function latestResultsDir(
  resultsDir: string,
  mission: EvalMission = "xray",
): string | undefined {
  return latestRunDir(resultsDir, mission);
}

function retryWait(events: readonly RunEvent[], attempt: number): number {
  const hinted = events.flatMap((event) =>
    event.type === "model.fallback" && event.payload.retryAfterMs !== undefined
      ? [event.payload.retryAfterMs]
      : [],
  );
  return Math.min(MAX_RETRY_WAIT_MS, Math.max(RETRY_BACKOFF_MS * 2 ** attempt, ...hinted));
}

export async function runEval(options: RunEvalOptions, deps: RunEvalDeps): Promise<EvalSummary> {
  return runMissionEval(missionAdapter(options.mission ?? "xray"), options, deps);
}

export async function runMissionEval<C extends BaseCase, X>(
  adapter: MissionAdapter<C, X>,
  options: RunEvalOptions,
  deps: RunEvalDeps,
): Promise<EvalSummary> {
  const startedAt = deps.now();
  const all = adapter.loadCases(options.datasetFile);
  const selected = selectById(all, options.caseIds).filter(
    (evalCase) => options.tag === undefined || evalCase.tags.includes(options.tag),
  );
  if (selected.length === 0) throw new Error("No cases selected");
  const replaySource = options.offline
    ? (options.replayDir ?? latestRunDir(options.resultsDir, adapter.mission))
    : undefined;
  if (options.offline && replaySource === undefined)
    throw new Error(
      `Offline mode needs stored ${adapter.mission} runs; none found under ${options.resultsDir}`,
    );
  const id = `${stamp(startedAt)}${options.offline ? "-replay" : ""}`;
  const outDir = runDir(options.resultsDir, adapter.mission, id);
  mkdirSync(outDir, { recursive: true });
  const versions = missionPromptVersions(adapter, options.prompts);
  const judgePrompt = loadEvalPrompt(adapter.judge.promptFile);
  const criteria = adapter.judge.criteria;
  const targets: BudgetTargets = {
    ...adapter.defaultTargets,
    maxTokens: RUN_BUDGETS[options.audience].maxTokens,
  };
  const judgeServing = new Map<string, { provider: string; model: string; calls: number }>();
  const cooldown = deps.cooldown ?? createSharedCooldown(deps.sleep, deps.now);

  const runOnce = async (
    evalCase: C,
    trial: number,
    attempt: number,
    stores: Partial<RunMissionOptions>,
  ) => {
    const runId = `eval_${stamp(startedAt)}_${evalCase.id}_${trial}_${attempt}`;
    const sink = createMemorySink(deps.now);
    const input = adapter.input(evalCase);
    await sink.emit({
      runId,
      type: "run.created",
      payload: {
        workspaceId: "eval",
        missionId: adapter.runtimeMissionId,
        input,
        actor: { type: "system", id: "eval-harness" },
        budget: RUN_BUDGETS[options.audience],
      },
    });
    try {
      await deps.runMission({
        runId,
        missionId: adapter.runtimeMissionId,
        input,
        context: { audience: options.audience, classification: "public" },
        env: deps.env,
        emit: sink.emit,
        now: deps.now,
        ...(adapter.hardDeadlineMs === undefined ? {} : { hardDeadlineMs: adapter.hardDeadlineMs }),
        ...(options.prompts === undefined ? {} : { prompts: options.prompts }),
        ...stores,
      });
    } catch (error) {
      if (
        !sink.events.some((event) => event.type === "run.failed" || event.type === "run.completed")
      )
        await sink.emit({
          runId,
          type: "run.failed",
          payload: {
            error: {
              code: "harness_error",
              message: (error instanceof Error ? error.message : "runMission threw").slice(0, 300),
            },
          },
        });
    }
    return { runId, events: sink.events };
  };

  const runTrial = async (evalCase: C, trial: number): Promise<TrialRecord> => {
    mkdirSync(join(outDir, evalCase.id), { recursive: true });
    let events: RunEvent[];
    let runId: string;
    let retries = 0;
    let judgeRecord: JudgeRecord | undefined;
    let extras: X | undefined;
    const trialStarted = deps.now().toISOString();
    if (replaySource !== undefined) {
      const source = trialFile(replaySource, evalCase.id, trial, "events.jsonl");
      if (!existsSync(source)) throw new Error(`Replay is missing ${source}`);
      events = parseEventLog(readFileSync(source, "utf8"));
      runId = events[0]?.runId ?? "unknown";
      judgeRecord = readJudgeRecord(trialFile(replaySource, evalCase.id, trial, "judge.json"));
      if (adapter.extras !== undefined) {
        const path = trialFile(replaySource, evalCase.id, trial, adapter.extras.file);
        if (existsSync(path))
          extras = adapter.extras.schema.parse(JSON.parse(readFileSync(path, "utf8")) as unknown);
      }
    } else {
      const stores = adapter.extras?.stores() ?? {};
      for (let attempt = 0; ; attempt += 1) {
        await cooldown.wait();
        const run = await runOnce(evalCase, trial, attempt, stores);
        const failed = run.events.find((event) => event.type === "run.failed");
        const code = failed?.type === "run.failed" ? failed.payload.error.code : undefined;
        if (code !== undefined && RETRYABLE_FAILURES.includes(code) && attempt < MAX_RETRIES) {
          writeFileSync(
            trialFile(outDir, evalCase.id, trial, `attempt-${attempt}.events.jsonl`),
            serialiseEventLog(run.events),
          );
          const wait = retryWait(run.events, attempt);
          deps.log(`  ${evalCase.id}#${trial}: ${code}, retrying in ${wait / 1000} s`);
          retries += 1;
          await cooldown.pause(wait);
          continue;
        }
        events = run.events;
        runId = run.runId;
        break;
      }
      if (adapter.extras !== undefined)
        extras = await adapter.extras.collect(
          {
            evalCase,
            events,
            env: deps.env,
            audience: options.audience,
            sleep: deps.sleep,
            now: deps.now,
            ...(deps.answerQuestion === undefined ? {} : { answer: deps.answerQuestion }),
            log: deps.log,
          },
          stores,
        );
    }
    writeFileSync(trialFile(outDir, evalCase.id, trial, "events.jsonl"), serialiseEventLog(events));
    if (adapter.extras !== undefined && extras !== undefined)
      writeFileSync(
        trialFile(outDir, evalCase.id, trial, adapter.extras.file),
        JSON.stringify(extras, null, 2),
      );
    const links =
      options.offline || deps.checkLinks === undefined
        ? undefined
        : await deps.checkLinks(adapter.citedUrls(events));
    const grade = adapter.grade({
      evalCase,
      events,
      targets: targetsFor(evalCase, targets),
      ...(links === undefined ? {} : { links }),
      ...(extras === undefined ? {} : { extras }),
    });
    let judgeError: string | undefined;
    if (
      judgeRecord === undefined &&
      !options.offline &&
      options.judge &&
      adapter.judge.ready(grade)
    ) {
      if (deps.judgeCompleter === undefined) judgeError = "no judge configured";
      else {
        try {
          judgeRecord = await runJudge({
            completer: deps.judgeCompleter,
            prompt: judgePrompt,
            schema: adapter.judge.schema,
            input: adapter.judge.render(evalCase, grade.deliverable, extras),
          });
        } catch (error) {
          judgeError = (error instanceof Error ? error.message : "judge failed").slice(0, 300);
        }
      }
    }
    const rawScores =
      judgeRecord === undefined ? undefined : verdictScores(judgeRecord.verdict, criteria);
    if (judgeRecord !== undefined) {
      writeFileSync(
        trialFile(outDir, evalCase.id, trial, "judge.json"),
        JSON.stringify(JudgeRecordSchema.parse(judgeRecord), null, 2),
      );
      const key = `${judgeRecord.provider}\u0000${judgeRecord.model}`;
      const existing = judgeServing.get(key);
      judgeServing.set(key, {
        provider: judgeRecord.provider,
        model: judgeRecord.model,
        calls: (existing?.calls ?? 0) + 1,
      });
    }
    const counted = grade.checks.filter((entry) => entry.skipped !== true);
    const record: TrialRecord = {
      caseId: evalCase.id,
      trial,
      runId,
      startedAt: events[0]?.at ?? trialStarted,
      outcome: grade.outcome,
      ...(grade.failureCode === undefined ? {} : { failureCode: grade.failureCode }),
      retries,
      passed: grade.outcome === "completed" && counted.every((entry) => entry.passed),
      score: checkScore(grade.checks),
      hardFailures: grade.hardFailures,
      checks: grade.checks,
      metrics: grade.metrics,
      missionMetrics: grade.missionMetrics,
      citationsVerified: grade.citationsVerified,
      serving: grade.serving,
      ...(judgeRecord === undefined || rawScores === undefined
        ? {}
        : { judge: { ...judgeRecord, scores: normaliseScores(rawScores) } }),
      ...(judgeError === undefined ? {} : { judgeError }),
    };
    writeFileSync(
      trialFile(outDir, evalCase.id, trial, "trial.json"),
      JSON.stringify(record, null, 2),
    );
    deps.onTrial?.(record);
    deps.log(
      `  ${evalCase.id}#${trial}: ${record.outcome}${record.failureCode === undefined ? "" : ` (${record.failureCode})`}, score ${record.score.toFixed(2)}, ${(record.metrics.latencyMs / 1000).toFixed(1)} s${record.hardFailures.length === 0 ? "" : `, hard failures: ${record.hardFailures.join(", ")}`}`,
    );
    return record;
  };

  const queue = selected.flatMap((evalCase) =>
    Array.from({ length: options.trials }, (_, trial) => ({ evalCase, trial })),
  );
  const records = new Map<string, TrialRecord[]>();
  const worker = async () => {
    for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
      const record = await runTrial(job.evalCase, job.trial);
      records.set(job.evalCase.id, [...(records.get(job.evalCase.id) ?? []), record]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, worker));

  const byCase = new Map(
    selected.map((evalCase) => [
      evalCase.id,
      (records.get(evalCase.id) ?? []).sort((a, b) => a.trial - b.trial),
    ]),
  );
  const flat = [...byCase.values()].flat();
  const checkPassRates: Record<string, { passed: number; counted: number }> = {};
  for (const entry of flat.flatMap((record) => record.checks)) {
    if (entry.skipped === true) continue;
    const current = checkPassRates[entry.kind] ?? { passed: 0, counted: 0 };
    checkPassRates[entry.kind] = {
      passed: current.passed + (entry.passed ? 1 : 0),
      counted: current.counted + 1,
    };
  }
  const baselineFile = baselinePath(options.resultsDir, adapter.mission);
  const comparisons = compareToBaseline(
    loadBaseline(baselineFile),
    adapter.dataset.version,
    byCase,
    options.threshold,
    criteria,
  );
  const judgedRun = replaySource === undefined ? id : (replaySource.split("/").at(-1) ?? id);
  const agreement = missionAgreement(
    options.resultsDir,
    adapter,
    flat.flatMap((record) => {
      const raw =
        record.judge === undefined ? undefined : verdictScores(record.judge.verdict, criteria);
      return raw === undefined
        ? []
        : [{ caseId: record.caseId, run: judgedRun, trial: record.trial, scores: raw }];
    }),
  );
  const latencies = flat.map((record) => record.metrics.latencyMs);
  const subjects = new Map(selected.map((evalCase) => [evalCase.id, adapter.subject(evalCase)]));
  const summary: EvalSummary = {
    id,
    mode: options.offline ? "replay" : "live",
    ...(replaySource === undefined ? {} : { replayOf: replaySource }),
    mission: adapter.mission,
    title: adapter.title,
    dataset: { name: adapter.dataset.name, version: adapter.dataset.version },
    audience: options.audience,
    startedAt: startedAt.toISOString(),
    finishedAt: deps.now().toISOString(),
    trialsPerCase: options.trials,
    promptVersions: versions,
    serving: mergeServing(flat),
    judgeServing: [...judgeServing.values()],
    judgeCriteria: [...criteria],
    targets,
    cases: selected.map((evalCase) =>
      summariseCase(
        evalCase.id,
        subjects.get(evalCase.id) ?? evalCase.id,
        adapter.mission,
        byCase.get(evalCase.id) ?? [],
        versions,
        criteria,
      ),
    ),
    overall: {
      trials: flat.length,
      passRate: wilsonInterval(flat.filter((record) => record.passed).length, flat.length),
      score: interval(flat.map((record) => record.score)) ?? {
        mean: 0,
        lower: null,
        upper: null,
        n: 0,
      },
      judge: judgeIntervals(flat, criteria),
      missionMetrics: metricIntervals(flat),
      p50LatencyMs: percentile(latencies, 0.5),
      p95LatencyMs: percentile(latencies, 0.95),
      totalCostMicroUsd: flat.reduce((sum, record) => sum + record.metrics.costMicroUsd, 0),
      hardFailures: flat.filter((record) => record.hardFailures.length > 0).length,
      errored: flat.filter((record) => record.outcome === "errored").length,
      retries: flat.reduce((sum, record) => sum + record.retries, 0),
      checkPassRates,
      trajectory: {
        toolCalls: flat.reduce((sum, record) => sum + record.metrics.toolCalls, 0),
        redundantFetches: flat.reduce((sum, record) => sum + record.metrics.redundantFetches, 0),
        policyDenials: flat.reduce((sum, record) => sum + record.metrics.policyDenials, 0),
        injectionFlags: flat.reduce((sum, record) => sum + record.metrics.injectionFlags, 0),
        fallbacks: flat.reduce((sum, record) => sum + record.metrics.fallbacks, 0),
      },
    },
    comparisons,
    regressions: comparisons.filter((comparison) => comparison.regression),
    agreement,
  };
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  const resultFile = buildResultFile(summary, byCase);
  mkdirSync(join(options.resultsDir, summary.mission), { recursive: true });
  writeFileSync(
    resultFilePath(options.resultsDir, summary),
    JSON.stringify(resultFile, null, 2) + "\n",
  );
  writeFileSync(join(outDir, "summary.md"), renderSummary(summary));
  if (options.baseline) {
    const baseline: Baseline = {
      summaryId: id,
      dataset: summary.dataset,
      createdAt: summary.finishedAt,
      promptVersions: versions,
      cases: Object.fromEntries(
        [...byCase].map(([caseId, list]) => [
          caseId,
          {
            scores: list.map((record) => record.score),
            judge: list.flatMap((record) => {
              const value = judgeMean(record, criteria);
              return value === undefined ? [] : [value];
            }),
            cost: list.map((record) => record.metrics.costMicroUsd),
          },
        ]),
      ),
    };
    writeFileSync(baselineFile, JSON.stringify(baseline, null, 2) + "\n");
  }
  return summary;
}

export function resultFilePath(resultsDir: string, summary: EvalSummary): string {
  return join(resultsDir, summary.mission, `${summary.id}.json`);
}

function resultMetrics(intervals: Partial<Record<string, Interval>>): Record<string, ResultMetric> {
  return Object.fromEntries(
    Object.entries(intervals).flatMap(([name, value]) =>
      value === undefined || value.n === 0 ? [] : [[name, value]],
    ),
  );
}

export function buildResultFile(
  summary: EvalSummary,
  byCase: ReadonlyMap<string, readonly TrialRecord[]>,
): EvalResultFile {
  const flat = [...byCase.values()].flat();
  return EvalResultFileSchema.parse({
    version: EVAL_RESULT_FILE_VERSION,
    id: summary.id,
    mission: summary.mission,
    mode: summary.mode,
    ...(summary.replayOf === undefined
      ? {}
      : { replayOf: summary.replayOf.split("/").at(-1) ?? summary.replayOf }),
    dataset: summary.dataset,
    audience: summary.audience,
    startedAt: summary.startedAt,
    finishedAt: summary.finishedAt,
    durationMs: Math.max(0, Date.parse(summary.finishedAt) - Date.parse(summary.startedAt)),
    trialsPerCase: summary.trialsPerCase,
    promptVersions: summary.promptVersions,
    models: summary.serving,
    judgeModels: summary.judgeServing,
    totals: {
      trials: flat.length,
      costMicroUsd: flat.reduce((sum, record) => sum + record.metrics.costMicroUsd, 0),
      tokens: flat.reduce((sum, record) => sum + record.metrics.totalTokens, 0),
    },
    cases: summary.cases.map((row) => ({
      caseId: row.caseId,
      company: row.company,
      trials: (byCase.get(row.caseId) ?? []).map((record) => ({
        trial: record.trial,
        runId: record.runId,
        outcome: record.outcome,
        ...(record.failureCode === undefined ? {} : { failureCode: record.failureCode }),
        passed: record.passed,
        score: record.score,
        citationsVerified: record.citationsVerified,
        judgeOverall: judgeMean(record, summary.judgeCriteria) ?? null,
        latencyMs: record.metrics.latencyMs,
        costMicroUsd: record.metrics.costMicroUsd,
        tokens: record.metrics.totalTokens,
        ...(Object.keys(record.missionMetrics).length === 0
          ? {}
          : { metrics: record.missionMetrics }),
        hardFailures: record.hardFailures,
        ...(record.serving.length === 0 ? {} : { serving: record.serving }),
      })),
    })),
    agreement: toResultAgreement(summary.agreement),
    judgeCriteria: resultMetrics(summary.overall.judge),
    missionMetrics: resultMetrics(summary.overall.missionMetrics),
  });
}

function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function formatInterval(value: Interval | undefined, digits = 2): string {
  if (value === undefined) return "n/a";
  if (value.lower === null || value.upper === null)
    return `${value.mean.toFixed(digits)} (n=${value.n}, no CI)`;
  return `${value.mean.toFixed(digits)} ± ${((value.upper - value.lower) / 2).toFixed(digits)} [${value.lower.toFixed(digits)}, ${value.upper.toFixed(digits)}]`;
}

export function renderSummary(summary: EvalSummary): string {
  const overall = summary.overall;
  const lines = [
    `# ${summary.title} eval ${summary.mode === "replay" ? "(Replay)" : "(Live)"}: ${summary.id}`,
    "",
    summary.mode === "replay"
      ? `Replay: re-graded stored event logs from \`${summary.replayOf ?? ""}\` without network; dead-link checks skipped, judge verdicts reused where recorded.`
      : "Live: missions ran in-process against the real targets and the configured model chain.",
    "",
    `- Dataset: ${summary.dataset.name} v${summary.dataset.version}; ${summary.cases.length} cases × ${summary.trialsPerCase} trials; audience ${summary.audience}`,
    `- Prompt versions: ${Object.entries(summary.promptVersions)
      .map(([name, version]) => `${name}@${version}`)
      .join(", ")}`,
    `- Serving: ${summary.serving.map((entry) => `${entry.role} ${entry.provider}/${entry.model} ×${entry.calls}`).join(", ") || "none"}`,
    `- Judge: ${summary.judgeServing.map((entry) => `${entry.provider}/${entry.model} ×${entry.calls}`).join(", ") || "not run"}`,
    `- Targets: latency < ${summary.targets.maxLatencyMs / 1000} s, cost ≤ ${summary.targets.maxCostMicroUsd} micro-USD, tokens ≤ ${summary.targets.maxTokens}`,
    "",
    "## Overall",
    "",
    "| Metric | Value |",
    "|---|---|",
    `| Pass rate (Wilson 95%) | ${pct(overall.passRate.rate)} [${pct(overall.passRate.lower)}, ${pct(overall.passRate.upper)}] (n=${overall.passRate.n}) |`,
    `| Deterministic score (mean ± 95% CI) | ${formatInterval(overall.score)} |`,
    `| Judge overall (0-1) | ${formatInterval(overall.judge.overall)} |`,
    ...summary.judgeCriteria.map(
      (criterion) => `| Judge ${criterion} | ${formatInterval(overall.judge[criterion])} |`,
    ),
    ...Object.entries(overall.missionMetrics).map(
      ([name, value]) => `| ${name} | ${formatInterval(value)} |`,
    ),
    `| Latency p50 / p95 | ${(overall.p50LatencyMs / 1000).toFixed(1)} s / ${(overall.p95LatencyMs / 1000).toFixed(1)} s |`,
    `| Total cost | ${overall.totalCostMicroUsd} micro-USD |`,
    `| Trials with hard failures | ${overall.hardFailures} |`,
    `| Errored (infrastructure) | ${overall.errored} |`,
    `| Rate-limit retries | ${overall.retries} |`,
    "",
    "## Cases",
    "",
    "| Case | Subject | Pass rate | Score | Judge | p50 latency | Cost | Hard fail | Errored | Failure codes |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...summary.cases.map(
      (row) =>
        `| ${row.caseId} | ${row.company.replace(/\|/g, "/")} | ${pct(row.passRate.rate)} (n=${row.passRate.n}) | ${formatInterval(row.score)} | ${formatInterval(row.judge.overall)} | ${(row.p50LatencyMs / 1000).toFixed(1)} s | ${row.meanCostMicroUsd} | ${row.hardFailures} | ${row.errored} | ${
          Object.entries(row.failureCodes)
            .map(([code, n]) => `${code}×${n}`)
            .join(", ") || "-"
        } |`,
    ),
    "",
    "## Checks",
    "",
    "| Check | Passed |",
    "|---|---|",
    ...Object.entries(overall.checkPassRates).map(
      ([kind, rate]) => `| ${kind} | ${rate.passed}/${rate.counted} |`,
    ),
    "",
    "## Trajectory",
    "",
    `Tool calls ${overall.trajectory.toolCalls}, redundant fetches ${overall.trajectory.redundantFetches}, policy denials ${overall.trajectory.policyDenials}, injection flags ${overall.trajectory.injectionFlags}, model fallbacks ${overall.trajectory.fallbacks}.`,
    "",
    "## Baseline comparison",
    "",
    summary.comparisons.length === 0
      ? "No baseline for this dataset version (write one with `--baseline`)."
      : [
          "One-sided Welch test of a worsening larger than the threshold (α = 0.05).",
          "",
          "| Scope | Metric | Baseline | Candidate | Worsening | p | Verdict |",
          "|---|---|---|---|---|---|---|",
          ...summary.comparisons.map((row) =>
            row.status === "insufficient_data"
              ? `| ${row.scope} | ${row.metric} | n=${row.baselineN} | n=${row.candidateN} | - | - | insufficient data |`
              : `| ${row.scope} | ${row.metric} | ${row.baselineMean?.toFixed(3) ?? ""} | ${row.candidateMean?.toFixed(3) ?? ""} | ${row.worsening?.toFixed(3) ?? ""} (threshold ${row.threshold?.toFixed(3) ?? ""}) | ${row.pValue?.toFixed(3) ?? ""} | ${row.regression ? "**regression**" : "ok"} |`,
          ),
        ].join("\n"),
    "",
    "## Judge-human agreement",
    "",
    renderAgreement(summary.agreement, `datasets/${summary.dataset.name}/human-labels.v1.jsonl`),
    "",
  ];
  return lines.join("\n");
}
