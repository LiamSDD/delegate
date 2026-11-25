import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import {
  housePlaybookFileName,
  housePlaybookKeys,
  type Playbook,
  type PromptFile,
} from "@delegate/runtime";
import { loadRuntimePrompts, type RuntimePrompts } from "@delegate/runtime/server";

import { digestRows, mergeServing, type ArmRow, type Houses } from "../evolve/arm";
import { promptVersionsOnDisk, readHousePlaybook, readPromptVersion } from "../evolve/files";
import { type EvolutionKind } from "../evolve/log";
import {
  ProposalError,
  candidatePlaybook,
  candidatePrompt,
  renderPromptFile,
  type Proposal,
  type ProposalInput,
} from "../evolve/propose";
import { missionTargets, type PromptKey } from "../evolve/targets";
import { loadEvalPrompt } from "../judge/rubric-judge";
import { missionAdapter } from "../missions";
import { type EvalMission } from "../results";
import { type SharedCooldown } from "../runner";
import {
  ARM_FILE_VERSION,
  armConfig,
  armFingerprint,
  armFromResult,
  armProblems,
  armReport,
  findReusableResult,
  modelsOf,
  observedTrialMs,
  poolFromRunDir,
  promptSlug,
  readArm,
  storedRunDir,
  writeArm,
  type ArmConfig,
  type ArmFile,
} from "./arm-store";
import { decideStep } from "./decide";
import {
  TRAINING_RECORD_VERSION,
  TrainingRecordSchema,
  type ArmReport,
  type TrainingDecisionStatus,
  type TrainingRecord,
} from "./record";
import {
  SESSION_VERSION,
  clearSession,
  loadSession,
  saveSession,
  sessionKey,
  stepKey,
  type Session,
  type SessionArgs,
} from "./session";

export const TRAIN_DEFAULTS = {
  rounds: 1,
  budgetMinutes: 60,
  trials: 3,
  estimateMargin: 1.25,
} as const;

const STEP_KINDS: readonly EvolutionKind[] = ["prompt", "playbook"];

export interface TrainOptions {
  missions: readonly EvalMission[];
  rounds: number;
  budgetMs: number;
  trials: number;
  dryRun: boolean;
  caseIds?: readonly string[];
  audience: "public-demo" | "owner";
  threshold?: number;
  concurrency: number;
  resultsDir: string;
  trainingDir: string;
  promptsDir: string;
  playbooksDir: string;
  repoRoot: string;
}

export interface ArmPlan {
  mission: EvalMission;
  label: "baseline" | "candidate";
  fingerprint: string;
  config: ArmConfig;
  prompts: Partial<RuntimePrompts>;
  houses: Houses;
  runsDir: string;
}

export interface ArmOutcome {
  evalRun: string;
  rows: ArmRow[];
  pool: Playbook[];
}

export interface RedteamSummary {
  suite: string;
  attacks: number;
  successes: number;
  asr: number;
}

export interface TrainDeps {
  now: () => Date;
  log: (line: string) => void;
  cooldown: SharedCooldown;
  runArm: (plan: ArmPlan) => Promise<ArmOutcome>;
  propose: (input: Omit<ProposalInput, "prompt">) => Promise<Proposal>;
  redteam: () => Promise<RedteamSummary>;
  livePrompts?: () => RuntimePrompts;
  resultPool?: (mission: EvalMission, evalRun: string, rows: readonly ArmRow[]) => Playbook[];
  estimateArmMs?: (mission: EvalMission, trials: number) => number;
}

export interface StepOutcome {
  mission: EvalMission;
  round: number;
  kind: EvolutionKind;
  status: TrainingDecisionStatus | "done-earlier";
  recordId: string;
}

export interface BudgetStop {
  mission: EvalMission;
  round: number;
  kind: EvolutionKind;
  before: "baseline arm" | "candidate arm" | "proposal";
  estimateMs: number;
  remainingMs: number;
}

export interface TrainReport {
  session: string;
  steps: StepOutcome[];
  stopped: BudgetStop | null;
  halted: { mission: EvalMission; reason: string }[];
  complete: boolean;
  promoted: string[];
}

interface Head {
  prompts: RuntimePrompts;
  overrides: Partial<RuntimePrompts>;
  houses: Record<string, Playbook | null>;
}

interface Context {
  options: TrainOptions;
  deps: TrainDeps;
  deadline: number;
  records: TrainingRecord[];
  session: Session;
  redteam?: RedteamSummary;
}

function stamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export function loadTrainingRecords(trainingDir: string): TrainingRecord[] {
  if (!existsSync(trainingDir)) return [];
  return readdirSync(trainingDir)
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .flatMap((entry) => {
      try {
        const parsed = TrainingRecordSchema.safeParse(
          JSON.parse(readFileSync(join(trainingDir, entry), "utf8")) as unknown,
        );
        return parsed.success ? [parsed.data] : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.finishedAt.localeCompare(b.finishedAt) || a.id.localeCompare(b.id));
}

function selectedCases(options: TrainOptions, mission: EvalMission) {
  const adapter = missionAdapter(mission);
  const all = adapter.loadCases();
  const wanted = options.caseIds;
  const cases = wanted === undefined ? all : all.filter((c) => wanted.includes(c.id));
  if (cases.length === 0) throw new Error(`No ${mission} cases selected`);
  return { adapter, cases };
}

function lineageHead(ctx: Context, mission: EvalMission): Head {
  const { options, deps } = ctx;
  const targets = missionTargets(mission);
  const live = (deps.livePrompts ?? loadRuntimePrompts)();
  const overrides: Partial<RuntimePrompts> = {};
  for (const key of targets.prompts) {
    const current = live[key];
    const promoted = ctx.records
      .flatMap((record) =>
        record.mission === mission &&
        record.decision.status === "promoted" &&
        record.change.prompt?.name === current.name &&
        record.change.prompt.to > current.version
          ? [record.change.prompt.to]
          : [],
      )
      .sort((a, b) => b - a);
    for (const version of promoted) {
      const file = readPromptVersion(options.promptsDir, current.name, version);
      if (file === null) continue;
      overrides[key] = file;
      break;
    }
  }
  const { adapter, cases } = selectedCases(options, mission);
  const keys = housePlaybookKeys(
    targets.runtimeMissionId,
    cases.map((c) => adapter.input(c)),
  );
  return {
    prompts: { ...live, ...overrides },
    overrides,
    houses: Object.fromEntries(
      keys.map((key) => [key, readHousePlaybook(options.playbooksDir, key)]),
    ),
  };
}

function configFor(
  options: TrainOptions,
  mission: EvalMission,
  prompts: RuntimePrompts,
  houses: Houses,
): ArmConfig {
  const { adapter, cases } = selectedCases(options, mission);
  const keys = [
    ...new Set<PromptKey>([...adapter.runtimePrompts, ...missionTargets(mission).prompts]),
  ];
  const files: PromptFile[] = [
    ...keys.map((key) => prompts[key]),
    loadEvalPrompt(adapter.judge.promptFile),
  ];
  return armConfig({
    mission,
    dataset: adapter.dataset,
    cases: cases.map((c) => c.id),
    trials: options.trials,
    audience: options.audience,
    prompts: files,
    houses,
  });
}

function versionsOf(config: ArmConfig, houses: Houses): TrainingRecord["parent"] {
  return {
    prompts: Object.fromEntries(
      Object.entries(config.prompts).map(([name, entry]) => [name, entry.version]),
    ),
    playbooks: Object.fromEntries(
      Object.entries(houses)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, house]) => [key, house?.version ?? 0]),
    ),
  };
}

export function estimateArmMs(options: TrainOptions, mission: EvalMission, trials: number): number {
  const observed = observedTrialMs(options.trainingDir, options.resultsDir, mission);
  const perTrial =
    observed ??
    missionAdapter(mission).defaultTargets.maxLatencyMs / Math.max(1, options.concurrency);
  return Math.ceil(perTrial * trials * TRAIN_DEFAULTS.estimateMargin);
}

type Obtained =
  | { type: "arm"; arm: ArmFile; source: ArmReport["source"]; problems: string[] }
  | { type: "budget"; estimateMs: number; remainingMs: number };

async function obtainArm(
  ctx: Context,
  plan: Omit<ArmPlan, "runsDir">,
  plain: boolean,
): Promise<Obtained> {
  const { options, deps } = ctx;
  const cached = readArm(options.trainingDir, plan.mission, plan.fingerprint);
  if (cached !== null)
    return {
      type: "arm",
      arm: cached,
      source: "cache",
      problems: armProblems(plan.config, cached.rows),
    };
  if (plan.label === "baseline" && plain) {
    const { match, latestReason } = findReusableResult(
      options.resultsDir,
      plan.mission,
      plan.config,
    );
    if (match !== undefined && armProblems(plan.config, match.rows).length === 0) {
      const pool = (
        deps.resultPool ??
        ((mission, evalRun, rows) =>
          poolFromRunDir(
            missionAdapter(mission),
            storedRunDir(options.resultsDir, mission, evalRun),
            rows,
          ))
      )(plan.mission, match.file.id, match.rows);
      const arm = armFromResult(plan.config, match, pool);
      writeArm(options.trainingDir, arm);
      deps.log(
        `  ${plan.mission} baseline: reusing result ${match.file.id} (${match.rows.length} trials, pool of ${pool.reduce((sum, p) => sum + p.entries.length, 0)} playbook entries)`,
      );
      return { type: "arm", arm, source: "result", problems: [] };
    }
    if (latestReason !== undefined) deps.log(`  ${plan.mission} baseline: ${latestReason}`);
  }
  const trials = plan.config.cases.length * plan.config.trials;
  const estimateMs = (deps.estimateArmMs ?? ((mission, n) => estimateArmMs(options, mission, n)))(
    plan.mission,
    trials,
  );
  const now = deps.now().getTime();
  const remainingMs = ctx.deadline - Math.max(now, deps.cooldown.until());
  if (estimateMs > remainingMs) return { type: "budget", estimateMs, remainingMs };
  await deps.cooldown.wait();
  const startedAt = deps.now();
  deps.log(
    `  ${plan.mission} ${plan.label} arm ${plan.fingerprint}: ${trials} trials, estimated ${Math.round(estimateMs / 60_000)} min`,
  );
  const outcome = await deps.runArm({
    ...plan,
    runsDir: join(options.trainingDir, "runs", plan.fingerprint),
  });
  const finishedAt = deps.now();
  const arm: ArmFile = {
    version: ARM_FILE_VERSION,
    fingerprint: plan.fingerprint,
    source: "run",
    config: plan.config,
    evalRun: outcome.evalRun,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    wallMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    rows: outcome.rows,
    models: modelsOf(outcome.rows),
    pool: outcome.pool,
  };
  const problems = armProblems(plan.config, arm.rows);
  if (problems.length === 0) writeArm(options.trainingDir, arm);
  return { type: "arm", arm, source: "run", problems };
}

function comparisonsAgainst(records: readonly TrainingRecord[], fingerprint: string): number {
  return (
    records.filter(
      (record) =>
        record.arms.baseline.fingerprint === fingerprint &&
        record.arms.candidate !== null &&
        record.decision.status !== "inconclusive",
    ).length + 1
  );
}

function writeNew(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") === content) return;
    throw new Error(`${path} already exists with other content; a shipped version is never edited`);
  }
  writeFileSync(path, content, { flag: "wx" });
}

interface Candidate {
  prompts: RuntimePrompts;
  overrides: Partial<RuntimePrompts>;
  houses: Record<string, Playbook | null>;
  change: TrainingRecord["change"];
  promote: () => TrainingRecord["promotion"];
}

function buildCandidate(
  ctx: Context,
  mission: EvalMission,
  head: Head,
  proposal: Proposal,
  pool: readonly Playbook[],
  lineageId: string,
  nextVersion: number | undefined,
): Candidate {
  const { options } = ctx;
  const targets = missionTargets(mission);
  if (proposal.kind === "prompt") {
    const key = targets.prompts.find((entry) => head.prompts[entry].name === proposal.target);
    if (key === undefined) throw new ProposalError(`Unknown target prompt ${proposal.target}`);
    const parent = head.prompts[key];
    const version =
      nextVersion ??
      Math.max(parent.version, ...promptVersionsOnDisk(options.promptsDir, parent.name)) + 1;
    const child = candidatePrompt(parent, proposal, lineageId, version);
    const file = join(options.promptsDir, `${child.name}.v${child.version}.md`);
    return {
      prompts: { ...head.prompts, [key]: child },
      overrides: { ...head.overrides, [key]: child },
      houses: head.houses,
      change: {
        prompt: { key, name: child.name, from: parent.version, to: child.version },
        playbook: null,
      },
      promote: () => {
        writeNew(file, renderPromptFile(child));
        return {
          file: relative(options.repoRoot, file),
          apply: `Point RUNTIME_PROMPT_FILES.${key} at ${child.name}.v${child.version}.md in a reviewed commit.`,
        };
      },
    };
  }
  const pooled = pool.find((entry) => entry.key === proposal.key);
  if (pooled === undefined) throw new ProposalError(`No pooled playbook for ${proposal.key}`);
  const parent = head.houses[proposal.key] ?? null;
  const child = candidatePlaybook(pooled, proposal.keep, parent);
  if (child.entries.length === 0)
    throw new ProposalError("The proposal kept no usable playbook entry");
  const file = join(options.playbooksDir, housePlaybookFileName(proposal.key));
  return {
    prompts: head.prompts,
    overrides: head.overrides,
    houses: { ...head.houses, [proposal.key]: child },
    change: {
      prompt: null,
      playbook: {
        key: proposal.key,
        from: parent?.version ?? 0,
        to: child.version,
        entries: child.entries.length,
      },
    },
    promote: () => {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(child, null, 2)}\n`);
      return { file: relative(options.repoRoot, file) };
    },
  };
}

type StepResult =
  | { type: "done"; record: TrainingRecord }
  | { type: "budget"; stop: Omit<BudgetStop, "mission" | "round" | "kind"> };

async function runStep(
  ctx: Context,
  mission: EvalMission,
  sessionRound: number,
  kind: EvolutionKind,
): Promise<StepResult> {
  const { options, deps, session } = ctx;
  const startedAt = deps.now();
  const round = (session.baseRound[mission] ?? 0) + sessionRound;
  const id = `${stamp(startedAt)}-${mission}-r${round}-${kind}`;
  const key = stepKey(mission, sessionRound, kind);
  const { adapter, cases } = selectedCases(options, mission);
  const targets = missionTargets(mission);
  const threshold = options.threshold ?? targets.regression.threshold;
  const head = lineageHead(ctx, mission);
  const baseConfig = configFor(options, mission, head.prompts, head.houses);
  const baseFingerprint = armFingerprint(baseConfig);
  const parentVersions = versionsOf(baseConfig, head.houses);
  const plain = Object.keys(head.overrides).length === 0;

  const finish = (input: {
    baseline: Extract<Obtained, { type: "arm" }>;
    candidate: Extract<Obtained, { type: "arm" }> | null;
    built: Candidate | null;
    proposal: Proposal | undefined;
    proposalError?: string;
    redteam: RedteamSummary | null;
  }): StepResult => {
    const comparisons = comparisonsAgainst(ctx.records, baseFingerprint);
    const { decision, comparison } = decideStep({
      baseline: {
        rows: input.baseline.arm.rows,
        models: input.baseline.arm.models,
        problems: input.baseline.problems,
      },
      candidate:
        input.candidate === null
          ? null
          : {
              rows: input.candidate.arm.rows,
              models: input.candidate.arm.models,
              problems: input.candidate.problems,
            },
      redteam: input.redteam,
      threshold,
      comparisons,
      ...(input.proposalError === undefined ? {} : { noCandidateReason: input.proposalError }),
    });
    const childConfig =
      input.built === null
        ? baseConfig
        : configFor(options, mission, input.built.prompts, input.built.houses);
    const promotion =
      decision.status === "promoted" && input.built !== null ? input.built.promote() : null;
    const finishedAt = deps.now();
    const arms = [input.baseline, ...(input.candidate === null ? [] : [input.candidate])];
    const record = TrainingRecordSchema.parse({
      version: TRAINING_RECORD_VERSION,
      id,
      mission,
      round,
      kind,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      wallMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      dataset: { name: adapter.dataset.name, version: adapter.dataset.version },
      cases: cases.map((c) => c.id),
      trialsPerCase: options.trials,
      parent: parentVersions,
      child: versionsOf(childConfig, input.built?.houses ?? head.houses),
      change: input.built?.change ?? { prompt: null, playbook: null },
      proposal: {
        rationale: input.proposal?.rationale ?? "",
        ...(input.proposal?.kind === "prompt" ? { addendum: input.proposal.addendum } : {}),
        ...(input.proposal?.kind === "playbook" ? { keep: input.proposal.keep } : {}),
        proposer: input.proposal?.proposer ?? null,
        ...(input.proposalError === undefined ? {} : { error: input.proposalError }),
      },
      arms: {
        baseline: armReport(input.baseline.arm, input.baseline.source),
        candidate:
          input.candidate === null ? null : armReport(input.candidate.arm, input.candidate.source),
      },
      comparison,
      redteam: input.redteam,
      decision,
      promotion,
      tokens: arms
        .filter((entry) => entry.source === "run")
        .reduce((sum, entry) => sum + entry.arm.rows.reduce((t, row) => t + row.tokens, 0), 0),
      models: mergeServing(arms.map((entry) => entry.arm.models)),
    });
    const path = join(options.trainingDir, `${id}.json`);
    mkdirSync(options.trainingDir, { recursive: true });
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
    ctx.records.push(record);
    if (decision.status !== "inconclusive") {
      session.steps[key] = { recordId: id };
      Reflect.deleteProperty(session.proposals, key);
    }
    saveSession(options.trainingDir, session);
    deps.log(
      `  ${mission} round ${round} ${kind}: ${decision.status}. ${decision.reasons.join(" ")}`,
    );
    return { type: "done", record };
  };

  deps.log(`${adapter.title} round ${round}, ${kind} step`);
  const baseline = await obtainArm(
    ctx,
    {
      mission,
      label: "baseline",
      fingerprint: baseFingerprint,
      config: baseConfig,
      prompts: head.overrides,
      houses: head.houses,
    },
    plain,
  );
  if (baseline.type === "budget")
    return {
      type: "budget",
      stop: {
        before: "baseline arm",
        estimateMs: baseline.estimateMs,
        remainingMs: baseline.remainingMs,
      },
    };
  if (baseline.problems.length > 0)
    return finish({ baseline, candidate: null, built: null, proposal: undefined, redteam: null });

  const stored = session.proposals[key];
  let proposal: Proposal | undefined =
    stored?.baseline === baseFingerprint ? stored.proposal : undefined;
  let nextVersion = stored?.baseline === baseFingerprint ? stored.nextPromptVersion : undefined;
  let built: Candidate | null = null;
  let proposalError: string | undefined;
  try {
    if (proposal === undefined) {
      const remainingMs = ctx.deadline - deps.now().getTime();
      if (remainingMs <= 0)
        return { type: "budget", stop: { before: "proposal", estimateMs: 0, remainingMs } };
      await deps.cooldown.wait();
      proposal = await deps.propose({
        kind,
        mission: { id: mission, title: adapter.title },
        targets: targets.prompts.map((entry) => head.prompts[entry]),
        digest: digestRows(baseline.arm.rows),
        pools: baseline.arm.pool,
      });
      if (proposal.kind !== kind)
        throw new ProposalError(`Asked for a ${kind} revision, got a ${proposal.kind} one`);
    }
    built = buildCandidate(
      ctx,
      mission,
      head,
      proposal,
      baseline.arm.pool,
      `training ${id}`,
      nextVersion,
    );
    nextVersion = built.change.prompt?.to;
    session.proposals[key] = {
      baseline: baseFingerprint,
      proposal,
      ...(nextVersion === undefined ? {} : { nextPromptVersion: nextVersion }),
    };
    saveSession(options.trainingDir, session);
  } catch (error) {
    if (!(error instanceof ProposalError)) throw error;
    proposalError = error.message;
  }
  if (built === null || proposal === undefined)
    return finish({
      baseline,
      candidate: null,
      built: null,
      proposal,
      ...(proposalError === undefined ? {} : { proposalError }),
      redteam: null,
    });

  const candidateConfig = configFor(options, mission, built.prompts, built.houses);
  const candidate = await obtainArm(
    ctx,
    {
      mission,
      label: "candidate",
      fingerprint: armFingerprint(candidateConfig),
      config: candidateConfig,
      prompts: built.overrides,
      houses: built.houses,
    },
    false,
  );
  if (candidate.type === "budget")
    return {
      type: "budget",
      stop: {
        before: "candidate arm",
        estimateMs: candidate.estimateMs,
        remainingMs: candidate.remainingMs,
      },
    };
  ctx.redteam ??= await deps.redteam();
  return finish({ baseline, candidate, built, proposal, redteam: ctx.redteam });
}

function sessionArgs(options: TrainOptions): SessionArgs {
  return {
    missions: [...options.missions],
    rounds: options.rounds,
    trials: options.trials,
    ...(options.caseIds === undefined ? {} : { cases: [...options.caseIds] }),
    audience: options.audience,
    ...(options.threshold === undefined ? {} : { threshold: options.threshold }),
  };
}

function openSession(
  options: TrainOptions,
  records: readonly TrainingRecord[],
  now: Date,
): Session {
  const args = sessionArgs(options);
  const existing = loadSession(options.trainingDir, args);
  if (existing !== null) return existing;
  return {
    version: SESSION_VERSION,
    key: sessionKey(args),
    createdAt: now.toISOString(),
    args,
    baseRound: Object.fromEntries(
      options.missions.map((mission) => [
        mission,
        Math.max(0, ...records.filter((r) => r.mission === mission).map((r) => r.round)),
      ]),
    ),
    steps: {},
    proposals: {},
  };
}

export async function runTraining(options: TrainOptions, deps: TrainDeps): Promise<TrainReport> {
  if (options.trials < 2) throw new Error("--trials must be at least 2 for a per-case comparison");
  if (options.dryRun) throw new Error("A dry run plans with planTraining and runs nothing");
  const started = deps.now();
  const records = loadTrainingRecords(options.trainingDir);
  const session = openSession(options, records, started);
  const resumed =
    Object.keys(session.steps).length > 0 || Object.keys(session.proposals).length > 0;
  const ctx: Context = {
    options,
    deps,
    deadline: started.getTime() + options.budgetMs,
    records,
    session,
  };
  deps.log(
    `Training session ${session.key}${resumed ? " (resumed)" : ""}: ${options.missions.join(", ")}; ${options.rounds} round(s), ${options.trials} trials per case, budget ${Math.round(options.budgetMs / 60_000)} min`,
  );
  saveSession(options.trainingDir, session);
  const steps: StepOutcome[] = [];
  const halted: TrainReport["halted"] = [];
  const promoted: string[] = [];
  let stopped: BudgetStop | null = null;

  rounds: for (let round = 1; round <= options.rounds; round += 1) {
    for (const mission of options.missions) {
      if (halted.some((entry) => entry.mission === mission)) continue;
      for (const kind of STEP_KINDS) {
        const done = session.steps[stepKey(mission, round, kind)];
        const recordRound = (session.baseRound[mission] ?? 0) + round;
        if (done !== undefined) {
          steps.push({
            mission,
            round: recordRound,
            kind,
            status: "done-earlier",
            recordId: done.recordId,
          });
          continue;
        }
        const result = await runStep(ctx, mission, round, kind);
        if (result.type === "budget") {
          stopped = { mission, round: recordRound, kind, ...result.stop };
          break rounds;
        }
        const { record } = result;
        steps.push({
          mission,
          round: record.round,
          kind,
          status: record.decision.status,
          recordId: record.id,
        });
        if (record.promotion !== null) promoted.push(record.promotion.file);
        if (record.decision.status === "inconclusive") {
          halted.push({ mission, reason: record.decision.reasons[0] ?? "inconclusive arm" });
          break;
        }
      }
    }
  }
  const complete = stopped === null && halted.length === 0;
  if (complete) clearSession(options.trainingDir, session);
  return { session: session.key, steps, stopped, halted, complete, promoted };
}

export interface PlannedArm {
  label: "baseline" | "candidate";
  action: "cached" | "reuse-result" | "run";
  detail: string;
  estimateMs: number;
}

export interface PlannedStep {
  mission: EvalMission;
  round: number;
  kind: EvolutionKind;
  done: boolean;
  arms: PlannedArm[];
  startsWithinBudget: boolean;
}

export interface TrainPlan {
  session: string;
  resumed: boolean;
  budgetMs: number;
  totalEstimateMs: number;
  missions: {
    mission: EvalMission;
    prompts: Record<string, number>;
    playbooks: Record<string, number>;
    targets: string[];
  }[];
  steps: PlannedStep[];
}

export function planTraining(
  options: TrainOptions,
  deps: Pick<TrainDeps, "now" | "livePrompts" | "estimateArmMs">,
): TrainPlan {
  const records = loadTrainingRecords(options.trainingDir);
  const session = openSession(options, records, deps.now());
  const ctx: Context = {
    options,
    deps: {
      ...deps,
      log: () => undefined,
      cooldown: { wait: () => Promise.resolve(), pause: () => Promise.resolve(), until: () => 0 },
      runArm: () => Promise.reject(new Error("a dry run starts no arm")),
      propose: () => Promise.reject(new Error("a dry run asks no model")),
      redteam: () => Promise.reject(new Error("a dry run does not run the red-team suite")),
    },
    deadline: 0,
    records,
    session,
  };
  const estimate = (mission: EvalMission, trials: number) =>
    (deps.estimateArmMs ?? ((m, n) => estimateArmMs(options, m, n)))(mission, trials);
  const missions: TrainPlan["missions"] = [];
  const baselineKnown = new Set<EvalMission>();
  const steps: PlannedStep[] = [];
  let elapsed = 0;
  for (const mission of options.missions) {
    const head = lineageHead(ctx, mission);
    const config = configFor(options, mission, head.prompts, head.houses);
    const versions = versionsOf(config, head.houses);
    missions.push({
      mission,
      prompts: versions.prompts,
      playbooks: versions.playbooks,
      targets: missionTargets(mission).prompts.map((key) => promptSlug(head.prompts[key].name)),
    });
  }
  for (let round = 1; round <= options.rounds; round += 1) {
    for (const mission of options.missions) {
      const head = lineageHead(ctx, mission);
      const config = configFor(options, mission, head.prompts, head.houses);
      const fingerprint = armFingerprint(config);
      const trials = config.cases.length * config.trials;
      const armMs = estimate(mission, trials);
      for (const kind of STEP_KINDS) {
        const done = session.steps[stepKey(mission, round, kind)] !== undefined;
        const arms: PlannedArm[] = [];
        if (!done) {
          if (baselineKnown.has(mission))
            arms.push({
              label: "baseline",
              action: "cached",
              detail: "the arm measured earlier in this plan",
              estimateMs: 0,
            });
          else if (readArm(options.trainingDir, mission, fingerprint) !== null)
            arms.push({
              label: "baseline",
              action: "cached",
              detail: `arm ${fingerprint}`,
              estimateMs: 0,
            });
          else {
            const plain = Object.keys(head.overrides).length === 0;
            const reuse = plain ? findReusableResult(options.resultsDir, mission, config) : {};
            if (reuse.match !== undefined && armProblems(config, reuse.match.rows).length === 0)
              arms.push({
                label: "baseline",
                action: "reuse-result",
                detail: `result ${reuse.match.file.id}`,
                estimateMs: 0,
              });
            else
              arms.push({
                label: "baseline",
                action: "run",
                detail:
                  reuse.latestReason ??
                  (plain
                    ? "no result file to reuse"
                    : "the parent is a promoted version no eval has measured"),
                estimateMs: armMs,
              });
          }
          baselineKnown.add(mission);
          arms.push({
            label: "candidate",
            action: "run",
            detail: `one ${kind} revision from the planner role`,
            estimateMs: armMs,
          });
        }
        const needs = arms.reduce((sum, arm) => sum + arm.estimateMs, 0);
        steps.push({
          mission,
          round: (session.baseRound[mission] ?? 0) + round,
          kind,
          done,
          arms,
          startsWithinBudget: elapsed + needs <= options.budgetMs,
        });
        elapsed += needs;
      }
    }
  }
  return {
    session: session.key,
    resumed: Object.keys(session.steps).length > 0 || Object.keys(session.proposals).length > 0,
    budgetMs: options.budgetMs,
    totalEstimateMs: elapsed,
    missions,
    steps,
  };
}

function minutes(ms: number): string {
  return `${(ms / 60_000).toFixed(1)} min`;
}

export function renderPlan(plan: TrainPlan): string {
  const lines = [
    `Dry run of training session ${plan.session}${plan.resumed ? " (would resume)" : ""}: nothing is run or written.`,
    `Estimated ${minutes(plan.totalEstimateMs)} of arms against a budget of ${minutes(plan.budgetMs)}.`,
    "",
  ];
  for (const entry of plan.missions) {
    lines.push(
      `${entry.mission}: prompts ${Object.entries(entry.prompts)
        .map(([name, version]) => `${name}@${version}`)
        .join(", ")}`,
      `  targets: ${entry.targets.join(", ")}; house playbooks: ${Object.entries(entry.playbooks)
        .map(([key, version]) => `${key} v${version}`)
        .join(", ")}`,
    );
  }
  lines.push("");
  for (const step of plan.steps) {
    lines.push(
      `${step.mission} round ${step.round} ${step.kind}: ${step.done ? "already recorded" : step.startsWithinBudget ? "fits the budget" : "would not start within the budget"}`,
      ...step.arms.map(
        (arm) =>
          `  ${arm.label}: ${arm.action === "run" ? `run, about ${minutes(arm.estimateMs)}` : arm.action === "cached" ? "cached" : "reuse"} (${arm.detail})`,
      ),
    );
  }
  return lines.join("\n");
}

export function renderReport(report: TrainReport, command: string): string {
  const lines = [`Training session ${report.session}`];
  for (const step of report.steps)
    lines.push(
      `  ${step.mission} round ${step.round} ${step.kind}: ${step.status} (${step.recordId})`,
    );
  for (const file of report.promoted) lines.push(`  promoted: ${file}`);
  for (const entry of report.halted)
    lines.push(`  ${entry.mission} skipped for the rest of this run: ${entry.reason}`);
  if (report.stopped !== null)
    lines.push(
      `Stopped at the time budget before the ${report.stopped.before} of ${report.stopped.mission} round ${report.stopped.round} (${report.stopped.kind}): it needs about ${minutes(report.stopped.estimateMs)}, ${minutes(Math.max(0, report.stopped.remainingMs))} were left.`,
    );
  lines.push(
    report.complete
      ? "Every planned step is recorded."
      : `Not finished. Run the same command again to continue; finished arms and steps are not repeated:\n  ${command}`,
  );
  return lines.join("\n");
}
