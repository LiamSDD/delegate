import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  emptyPlaybook,
  type Playbook,
  type PlaybookStore,
  type PromptFile,
} from "@delegate/runtime";

import { type EvalSummary, type TrialRecord } from "../runner";
import { decideEvolution, type ArmTrial } from "./gate";
import {
  EVOLUTION_LOG_VERSION,
  EvolutionLogSchema,
  type EvolutionKind,
  type EvolutionLog,
} from "./log";
import {
  ProposalError,
  candidatePlaybook,
  candidatePrompt,
  renderPromptFile,
  type Proposal,
} from "./propose";

export const PLAYBOOK_KEY = "company-xray";

export interface ArmSpec {
  label: "baseline" | "candidate";
  planner: PromptFile;
  house: Playbook | null;
  store: PlaybookStore;
}

export interface ArmResult {
  summary: EvalSummary;
  trials: TrialRecord[];
}

export interface EvolutionDeps {
  now: () => Date;
  runArm: (arm: ArmSpec) => Promise<ArmResult>;
  propose: (input: {
    kind: EvolutionKind;
    planner: PromptFile;
    summary: EvalSummary;
    pool: Playbook | null;
  }) => Promise<Proposal>;
  redteam: () => Promise<{ suite: string; attacks: number; successes: number; asr: number }>;
  createStore: (seed: readonly Playbook[]) => PlaybookStore & { all(scope: "house"): Playbook[] };
  log: (line: string) => void;
}

export interface EvolutionOptions {
  kind: EvolutionKind;
  trials: number;
  threshold: number;
  planner: PromptFile;
  nextPromptVersion: number;
  house: Playbook | null;
  evolutionDir: string;
  promptsDir: string;
  playbooksDir: string;
}

export interface EvolutionOutcome {
  log: EvolutionLog;
  logPath: string;
}

function stamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function armTrials(trials: readonly TrialRecord[]): ArmTrial[] {
  return trials.map((trial) => ({
    caseId: trial.caseId,
    score: trial.score,
    passed: trial.passed,
    hardFailures: trial.hardFailures.length,
  }));
}

function fixedStore(house: Playbook | null, sink: PlaybookStore | null): PlaybookStore {
  return {
    read: () => Promise.resolve({ workspace: null, house }),
    record: (run) => (sink === null ? Promise.resolve() : sink.record(run, { house: true })),
  };
}

function playbookRef(playbook: Playbook | null) {
  return {
    key: playbook?.key ?? PLAYBOOK_KEY,
    version: playbook?.version ?? 0,
    entries: playbook?.entries.length ?? 0,
  };
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export async function runEvolution(
  options: EvolutionOptions,
  deps: EvolutionDeps,
): Promise<EvolutionOutcome> {
  const startedAt = deps.now();
  const id = `${stamp(startedAt)}-${options.kind}`;
  const parentPrompt = { name: options.planner.name, version: options.planner.version };
  const parentHouse = options.house;
  const pool = deps.createStore(parentHouse === null ? [] : [parentHouse]);

  deps.log(`Evolution ${id}: baseline arm with ${parentPrompt.name}@${parentPrompt.version}`);
  const baseline = await deps.runArm({
    label: "baseline",
    planner: options.planner,
    house: parentHouse,
    store: fixedStore(parentHouse, pool),
  });
  const pooled =
    pool.all("house").find((playbook) => playbook.key === PLAYBOOK_KEY) ??
    emptyPlaybook(PLAYBOOK_KEY, "house", startedAt.toISOString());

  let proposal: Proposal | undefined;
  let proposalError: string | undefined;
  try {
    proposal = await deps.propose({
      kind: options.kind,
      planner: options.planner,
      summary: baseline.summary,
      pool: pooled,
    });
  } catch (error) {
    if (!(error instanceof ProposalError)) throw error;
    proposalError = error.message;
  }

  const childPrompt =
    proposal?.kind === "prompt"
      ? candidatePrompt(options.planner, proposal, id, options.nextPromptVersion)
      : options.planner;
  const childHouse =
    proposal?.kind === "playbook"
      ? candidatePlaybook(pooled, proposal.keep, parentHouse)
      : parentHouse;

  let candidate: ArmResult | undefined;
  if (proposal !== undefined) {
    deps.log(
      `Evolution ${id}: candidate arm with ${childPrompt.name}@${childPrompt.version}, house playbook v${childHouse?.version ?? 0}`,
    );
    candidate = await deps.runArm({
      label: "candidate",
      planner: childPrompt,
      house: childHouse,
      store: fixedStore(childHouse, null),
    });
  }
  const redteam = await deps.redteam();
  const decision = decideEvolution({
    baseline: armTrials(baseline.trials),
    candidate: armTrials(candidate?.trials ?? []),
    redteam,
    threshold: options.threshold,
    ...(proposalError === undefined
      ? {}
      : { extraReasons: [`No candidate was evaluated: ${proposalError}`] }),
  });

  let promotion: EvolutionLog["promotion"] = null;
  if (decision.status === "promoted" && proposal !== undefined) {
    if (proposal.kind === "prompt") {
      const file = join(options.promptsDir, `${childPrompt.name}.v${childPrompt.version}.md`);
      write(file, renderPromptFile(childPrompt));
      promotion = {
        file,
        apply: `Point RUNTIME_PROMPT_FILES.planner at ${childPrompt.name}.v${childPrompt.version}.md in a reviewed commit.`,
      };
    } else if (childHouse !== null) {
      const file = join(options.playbooksDir, `${PLAYBOOK_KEY}.house.json`);
      write(file, `${JSON.stringify(childHouse, null, 2)}\n`);
      promotion = { file };
    }
  }

  const log = EvolutionLogSchema.parse({
    version: EVOLUTION_LOG_VERSION,
    id,
    mission: "xray",
    kind: options.kind,
    startedAt: startedAt.toISOString(),
    finishedAt: deps.now().toISOString(),
    trialsPerCase: options.trials,
    cases: baseline.summary.cases.map((row) => row.caseId),
    parent: { prompt: parentPrompt, playbook: playbookRef(parentHouse) },
    child: {
      prompt: { name: childPrompt.name, version: childPrompt.version },
      playbook: playbookRef(childHouse),
    },
    proposal: {
      rationale: proposal?.rationale ?? "",
      ...(proposal?.kind === "prompt" ? { addendum: proposal.addendum } : {}),
      ...(proposal?.kind === "playbook" ? { keep: proposal.keep } : {}),
      proposer: proposal?.proposer ?? null,
      ...(proposalError === undefined ? {} : { error: proposalError }),
    },
    evalRuns: { baseline: baseline.summary.id, candidate: candidate?.summary.id ?? null },
    redteam,
    decision,
    promotion,
  });
  const logPath = join(options.evolutionDir, `${id}.json`);
  write(logPath, `${JSON.stringify(log, null, 2)}\n`);
  deps.log(`Evolution ${id}: ${decision.status}. ${decision.reasons.join(" ")}`);
  return { log, logPath };
}
