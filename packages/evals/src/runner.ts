import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  RUN_BUDGETS,
  loadCompanyXrayPrompts,
  type RunMissionOptions,
  type RunMissionResult,
} from "@delegate/runtime/server";
import { z } from "zod";

import {
  XRAY_DATASET,
  datasetPath,
  loadXrayDataset,
  selectCases,
  type XrayCase,
} from "./datasets/xray";
import { createMemorySink, parseEventLog, serialiseEventLog } from "./event-log";
import {
  DEFAULT_XRAY_TARGETS,
  citedUrls,
  deterministicScore,
  gradeXray,
  type GradedCheck,
  type LinkStatus,
  type ServingRecord,
  type XrayGrade,
  type XrayMetrics,
  type XrayTargets,
} from "./graders/xray";
import {
  agreementReport,
  loadHumanLabels,
  renderAgreement,
  type AgreementReport,
} from "./judge/calibration";
import {
  JUDGE_CRITERIA,
  JudgeVerdictSchema,
  judgeXray,
  loadJudgePrompt,
  normalisedJudgeScores,
  type JudgeCompleter,
  type JudgeCriterion,
} from "./judge/xray-judge";
import {
  EVAL_RESULT_FILE_VERSION,
  EvalResultFileSchema,
  type EvalResultFile,
  type ResultAgreement,
} from "./results";
import { compareScores, mean, meanConfidenceInterval, wilsonInterval } from "./stats";
import { summariseTrials, type Trial } from "./types";

export const RUNTIME_MISSION_ID = "company-xray";
export const RETRYABLE_FAILURES: readonly string[] = ["no_model_available"];
export const RETRY_BACKOFF_MS = 60_000;
export const MAX_RETRIES = 2;

export interface RunEvalOptions {
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
}

export interface RunEvalDeps {
  runMission: (options: RunMissionOptions) => Promise<RunMissionResult>;
  env: Record<string, string | undefined>;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  judgeCompleter?: JudgeCompleter;
  checkLinks?: (urls: readonly string[]) => Promise<Map<string, LinkStatus>>;
  log: (line: string) => void;
  onTrial?: (record: TrialRecord) => void;
}

const JudgeRecordSchema = z.object({
  provider: z.string(),
  model: z.string(),
  promptName: z.string(),
  promptVersion: z.number().int().positive(),
  repaired: z.boolean(),
  verdict: JudgeVerdictSchema,
});
type JudgeRecord = z.infer<typeof JudgeRecordSchema>;

export interface TrialRecord {
  caseId: string;
  trial: number;
  runId: string;
  startedAt: string;
  outcome: XrayGrade["outcome"];
  failureCode?: string;
  retries: number;
  passed: boolean;
  score: number;
  hardFailures: string[];
  checks: GradedCheck[];
  metrics: XrayMetrics;
  serving: ServingRecord[];
  judge?: JudgeRecord & { scores: Record<JudgeCriterion, number> };
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
  judge: Partial<Record<JudgeCriterion | "overall", Interval>>;
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
  mission: "xray";
  dataset: { name: string; version: number };
  audience: RunEvalOptions["audience"];
  startedAt: string;
  finishedAt: string;
  trialsPerCase: number;
  promptVersions: Record<string, number>;
  serving: ServingRecord[];
  judgeServing: { provider: string; model: string; calls: number }[];
  targets: XrayTargets;
  cases: CaseSummary[];
  overall: {
    trials: number;
    passRate: { rate: number; lower: number; upper: number; n: number };
    score: Interval;
    judge: Partial<Record<JudgeCriterion | "overall", Interval>>;
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

function promptVersions(): Record<string, number> {
  const prompts = loadCompanyXrayPrompts();
  const judge = loadJudgePrompt();
  return Object.fromEntries(
    [prompts.reader, prompts.researcher, prompts.synthesis, judge].map((prompt) => [
      promptSlug(prompt.name),
      prompt.version,
    ]),
  );
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

function interval(values: readonly number[]): Interval | undefined {
  if (values.length === 0) return undefined;
  if (values.length === 1) return { mean: values[0] ?? 0, lower: null, upper: null, n: 1 };
  const ci = meanConfidenceInterval(values);
  return {
    mean: ci.mean,
    lower: Math.max(0, ci.lower),
    upper: Math.min(1, ci.upper),
    n: ci.n,
  };
}

function judgeIntervals(records: readonly TrialRecord[]) {
  const judged = records.flatMap((record) =>
    record.judge === undefined ? [] : [record.judge.scores],
  );
  const result: Partial<Record<JudgeCriterion | "overall", Interval>> = {};
  for (const criterion of JUDGE_CRITERIA) {
    const value = interval(judged.map((scores) => scores[criterion]));
    if (value !== undefined) result[criterion] = value;
  }
  const overall = interval(judged.map((scores) => mean(JUDGE_CRITERIA.map((c) => scores[c]))));
  if (overall !== undefined) result.overall = overall;
  return result;
}

function judgeMean(record: TrialRecord): number | undefined {
  return record.judge === undefined
    ? undefined
    : mean(JUDGE_CRITERIA.map((criterion) => record.judge?.scores[criterion] ?? 0));
}

function toTrial(record: TrialRecord, versions: Record<string, number>): Trial {
  return {
    caseId: record.caseId,
    mission: "xray",
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
  evalCase: XrayCase,
  records: readonly TrialRecord[],
  versions: Record<string, number>,
): CaseSummary {
  const failureCodes: Record<string, number> = {};
  for (const record of records) {
    if (record.failureCode !== undefined)
      failureCodes[record.failureCode] = (failureCodes[record.failureCode] ?? 0) + 1;
  }
  const base = {
    caseId: evalCase.id,
    company: evalCase.company.name,
    trials: records.length,
    judge: judgeIntervals(records),
    hardFailures: records.filter((record) => record.hardFailures.length > 0).length,
    errored: records.filter((record) => record.outcome === "errored").length,
    failureCodes,
  };
  const summarisable = records.length >= 2 && records.every((record) => record.serving.length > 0);
  if (summarisable) {
    const result = summariseTrials(records.map((record) => toTrial(record, versions)));
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
  const scores = records.map((record) => record.score);
  return {
    ...base,
    passRate: wilsonInterval(records.filter((record) => record.passed).length, records.length),
    score: interval(scores) ?? { mean: 0, lower: null, upper: null, n: 0 },
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
  byCase: ReadonlyMap<string, TrialRecord[]>,
  threshold: number,
): Comparison[] {
  if (baseline?.dataset.version !== XRAY_DATASET.version) return [];
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
      const value = judgeMean(record);
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

export function latestResultsDir(resultsDir: string): string | undefined {
  if (!existsSync(resultsDir)) return undefined;
  const dirs = readdirSync(resultsDir)
    .filter((name) => existsSync(join(resultsDir, name, "summary.json")))
    .filter((name) => statSync(join(resultsDir, name)).isDirectory())
    .sort();
  const last = dirs.at(-1);
  return last === undefined ? undefined : join(resultsDir, last);
}

function trialPath(dir: string, caseId: string, trial: number, suffix: string) {
  return join(dir, caseId, `${trial}.${suffix}`);
}

export async function runEval(options: RunEvalOptions, deps: RunEvalDeps): Promise<EvalSummary> {
  const startedAt = deps.now();
  const all = loadXrayDataset(datasetPath(options.datasetFile));
  const selected = selectCases(all, options.caseIds).filter(
    (evalCase) => options.tag === undefined || evalCase.tags.includes(options.tag),
  );
  if (selected.length === 0) throw new Error("No cases selected");
  const replaySource = options.offline
    ? (options.replayDir ?? latestResultsDir(options.resultsDir))
    : undefined;
  if (options.offline && replaySource === undefined)
    throw new Error(`Offline mode needs stored results; none found in ${options.resultsDir}`);
  const id = `${stamp(startedAt)}${options.offline ? "-replay" : ""}`;
  const outDir = join(options.resultsDir, id);
  mkdirSync(outDir, { recursive: true });
  const versions = promptVersions();
  const judgePrompt = loadJudgePrompt();
  const targets: XrayTargets = {
    ...DEFAULT_XRAY_TARGETS,
    maxTokens: RUN_BUDGETS[options.audience].maxTokens,
  };
  const judgeServing = new Map<string, { provider: string; model: string; calls: number }>();

  const targetsFor = (evalCase: XrayCase): XrayTargets => {
    const fromCase = { ...targets };
    for (const check of evalCase.checks) {
      if (check.kind === "min_citations") fromCase.minCitations = check.min;
      if (check.kind === "max_latency_ms") fromCase.maxLatencyMs = check.max;
      if (check.kind === "max_cost_micro_usd") fromCase.maxCostMicroUsd = check.max;
    }
    return fromCase;
  };

  const runOnce = async (evalCase: XrayCase, trial: number, attempt: number) => {
    const runId = `eval_${stamp(startedAt)}_${evalCase.id}_${trial}_${attempt}`;
    const sink = createMemorySink(deps.now);
    await sink.emit({
      runId,
      type: "run.created",
      payload: {
        workspaceId: "eval",
        missionId: RUNTIME_MISSION_ID,
        input: evalCase.input,
        actor: { type: "system", id: "eval-harness" },
        budget: RUN_BUDGETS[options.audience],
      },
    });
    try {
      await deps.runMission({
        runId,
        missionId: RUNTIME_MISSION_ID,
        input: evalCase.input,
        context: { audience: options.audience, classification: "public" },
        env: deps.env,
        emit: sink.emit,
        now: deps.now,
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

  const runTrial = async (evalCase: XrayCase, trial: number): Promise<TrialRecord> => {
    mkdirSync(join(outDir, evalCase.id), { recursive: true });
    let events;
    let runId: string;
    let retries = 0;
    let judgeRecord: JudgeRecord | undefined;
    const trialStarted = deps.now().toISOString();
    if (replaySource !== undefined) {
      const source = trialPath(replaySource, evalCase.id, trial, "events.jsonl");
      if (!existsSync(source)) throw new Error(`Replay is missing ${source}`);
      events = parseEventLog(readFileSync(source, "utf8"));
      runId = events[0]?.runId ?? "unknown";
      const judgePath = trialPath(replaySource, evalCase.id, trial, "judge.json");
      if (existsSync(judgePath))
        judgeRecord = JudgeRecordSchema.parse(
          JSON.parse(readFileSync(judgePath, "utf8")) as unknown,
        );
    } else {
      for (let attempt = 0; ; attempt += 1) {
        const run = await runOnce(evalCase, trial, attempt);
        const failed = run.events.find((event) => event.type === "run.failed");
        const code = failed?.type === "run.failed" ? failed.payload.error.code : undefined;
        if (code !== undefined && RETRYABLE_FAILURES.includes(code) && attempt < MAX_RETRIES) {
          writeFileSync(
            trialPath(outDir, evalCase.id, trial, `attempt-${attempt}.events.jsonl`),
            serialiseEventLog(run.events),
          );
          const wait = RETRY_BACKOFF_MS * 2 ** attempt;
          deps.log(`  ${evalCase.id}#${trial}: ${code}, retrying in ${wait / 1000} s`);
          retries += 1;
          await deps.sleep(wait);
          continue;
        }
        events = run.events;
        runId = run.runId;
        break;
      }
    }
    writeFileSync(trialPath(outDir, evalCase.id, trial, "events.jsonl"), serialiseEventLog(events));
    const links =
      options.offline || deps.checkLinks === undefined
        ? undefined
        : await deps.checkLinks(citedUrls(events));
    const grade = gradeXray({
      events,
      targets: targetsFor(evalCase),
      ...(links === undefined ? {} : { links }),
    });
    let judgeError: string | undefined;
    const schemaValid =
      grade.checks.find((entry) => entry.kind === "schema_valid")?.passed === true;
    if (judgeRecord === undefined && !options.offline && options.judge && schemaValid) {
      if (deps.judgeCompleter === undefined) judgeError = "no judge configured";
      else {
        try {
          judgeRecord = await judgeXray({
            completer: deps.judgeCompleter,
            prompt: judgePrompt,
            evalCase,
            brief: grade.brief,
          });
        } catch (error) {
          judgeError = (error instanceof Error ? error.message : "judge failed").slice(0, 300);
        }
      }
    }
    if (judgeRecord !== undefined) {
      writeFileSync(
        trialPath(outDir, evalCase.id, trial, "judge.json"),
        JSON.stringify(judgeRecord, null, 2),
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
      score: deterministicScore(grade),
      hardFailures: grade.hardFailures,
      checks: grade.checks,
      metrics: grade.metrics,
      serving: grade.serving,
      ...(judgeRecord === undefined
        ? {}
        : { judge: { ...judgeRecord, scores: normalisedJudgeScores(judgeRecord.verdict) } }),
      ...(judgeError === undefined ? {} : { judgeError }),
    };
    writeFileSync(
      trialPath(outDir, evalCase.id, trial, "trial.json"),
      JSON.stringify(record, null, 2),
    );
    deps.onTrial?.(record);
    deps.log(
      `  ${evalCase.id}#${trial}: ${record.outcome}${record.failureCode === undefined ? "" : ` (${record.failureCode})`}, score ${record.score.toFixed(2)}, ${(record.metrics.latencyMs / 1000).toFixed(1)} s${record.hardFailures.length === 0 ? "" : `, hard failures: ${record.hardFailures.join(", ")}`}`,
    );
    return record;
  };

  const jobs = selected.flatMap((evalCase) =>
    Array.from({ length: options.trials }, (_, trial) => ({ evalCase, trial })),
  );
  const records = new Map<string, TrialRecord[]>();
  const queue = [...jobs];
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
  const baselinePath = join(options.resultsDir, "baseline.json");
  const comparisons = compareToBaseline(loadBaseline(baselinePath), byCase, options.threshold);
  const humanLabels = loadHumanLabels(datasetPath("human-labels.v1.jsonl"));
  const agreement = agreementReport(
    humanLabels,
    flat.flatMap((record) =>
      record.judge === undefined
        ? []
        : [
            {
              caseId: record.caseId,
              run: replaySource === undefined ? id : (replaySource.split("/").at(-1) ?? id),
              trial: record.trial,
              verdict: record.judge.verdict,
            },
          ],
    ),
  );
  const latencies = flat.map((record) => record.metrics.latencyMs);
  const summary: EvalSummary = {
    id,
    mode: options.offline ? "replay" : "live",
    ...(replaySource === undefined ? {} : { replayOf: replaySource }),
    mission: "xray",
    dataset: { name: XRAY_DATASET.name, version: XRAY_DATASET.version },
    audience: options.audience,
    startedAt: startedAt.toISOString(),
    finishedAt: deps.now().toISOString(),
    trialsPerCase: options.trials,
    promptVersions: versions,
    serving: mergeServing(flat),
    judgeServing: [...judgeServing.values()],
    targets,
    cases: selected.map((evalCase) =>
      summariseCase(evalCase, byCase.get(evalCase.id) ?? [], versions),
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
      judge: judgeIntervals(flat),
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
  const resultFile = buildResultFile(summary, selected, byCase);
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
              const value = judgeMean(record);
              return value === undefined ? [] : [value];
            }),
            cost: list.map((record) => record.metrics.costMicroUsd),
          },
        ]),
      ),
    };
    writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + "\n");
  }
  return summary;
}

const CITATION_CHECKS: readonly string[] = ["citations_resolve", "quotes_in_sources"];

function citationsVerified(record: TrialRecord): boolean | null {
  if (record.outcome === "errored") return null;
  const counted = record.checks.filter(
    (entry) => CITATION_CHECKS.includes(entry.kind) && entry.skipped !== true,
  );
  return counted.length === 0 ? null : counted.every((entry) => entry.passed);
}

function resultAgreement(report: AgreementReport): ResultAgreement {
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

export function resultFilePath(resultsDir: string, summary: EvalSummary): string {
  return join(resultsDir, summary.mission, `${summary.id}.json`);
}

export function buildResultFile(
  summary: EvalSummary,
  cases: readonly XrayCase[],
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
    cases: cases.map((evalCase) => ({
      caseId: evalCase.id,
      company: evalCase.company.name,
      trials: (byCase.get(evalCase.id) ?? []).map((record) => ({
        trial: record.trial,
        runId: record.runId,
        outcome: record.outcome,
        ...(record.failureCode === undefined ? {} : { failureCode: record.failureCode }),
        passed: record.passed,
        score: record.score,
        citationsVerified: citationsVerified(record),
        judgeOverall: judgeMean(record) ?? null,
        latencyMs: record.metrics.latencyMs,
        costMicroUsd: record.metrics.costMicroUsd,
        tokens: record.metrics.totalTokens,
      })),
    })),
    agreement: resultAgreement(summary.agreement),
  });
}

function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function formatInterval(value: Interval | undefined): string {
  if (value === undefined) return "n/a";
  if (value.lower === null || value.upper === null)
    return `${value.mean.toFixed(2)} (n=${value.n}, no CI)`;
  return `${value.mean.toFixed(2)} ± ${((value.upper - value.lower) / 2).toFixed(2)} [${value.lower.toFixed(2)}, ${value.upper.toFixed(2)}]`;
}

export function renderSummary(summary: EvalSummary): string {
  const overall = summary.overall;
  const lines = [
    `# Company X-ray eval ${summary.mode === "replay" ? "(Replay)" : "(Live)"}: ${summary.id}`,
    "",
    summary.mode === "replay"
      ? `Replay: re-graded stored event logs from \`${summary.replayOf ?? ""}\` without network; dead-link checks skipped, judge verdicts reused where recorded.`
      : "Live: missions ran in-process against the real sites and the configured model chain.",
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
    ...JUDGE_CRITERIA.map(
      (criterion) => `| Judge ${criterion} | ${formatInterval(overall.judge[criterion])} |`,
    ),
    `| Latency p50 / p95 | ${(overall.p50LatencyMs / 1000).toFixed(1)} s / ${(overall.p95LatencyMs / 1000).toFixed(1)} s |`,
    `| Total cost | ${overall.totalCostMicroUsd} micro-USD |`,
    `| Trials with hard failures | ${overall.hardFailures} |`,
    `| Errored (infrastructure) | ${overall.errored} |`,
    `| Rate-limit retries | ${overall.retries} |`,
    "",
    "## Cases",
    "",
    "| Case | Company | Pass rate | Score | Judge | p50 latency | Cost | Hard fail | Errored | Failure codes |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...summary.cases.map(
      (row) =>
        `| ${row.caseId} | ${row.company} | ${pct(row.passRate.rate)} (n=${row.passRate.n}) | ${formatInterval(row.score)} | ${formatInterval(row.judge.overall)} | ${(row.p50LatencyMs / 1000).toFixed(1)} s | ${row.meanCostMicroUsd} | ${row.hardFailures} | ${row.errored} | ${
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
    renderAgreement(summary.agreement),
    "",
  ];
  return lines.join("\n");
}
