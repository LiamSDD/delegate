import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  emptyPlaybook,
  housePlaybookFileName,
  type Playbook,
  type PlaybookStore,
  type PromptFile,
} from "@delegate/runtime";
import { type RuntimePrompts } from "@delegate/runtime/server";

import { type EvalMission } from "../results";
import { type EvalSummary, type TrialRecord } from "../runner";
import { armTrialsOf, digestRows, readOnlyHouseStore, rowFromTrial, type Houses } from "./arm";
import { decideEvolution } from "./gate";
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
  type ProposalInput,
} from "./propose";
import { type PromptKey } from "./targets";

export interface ArmSpec {
  label: "baseline" | "candidate";
  mission: EvalMission;
  prompts: Partial<RuntimePrompts>;
  houses: Houses;
  store: PlaybookStore;
}

export interface ArmResult {
  summary: EvalSummary;
  trials: TrialRecord[];
}

export interface EvolutionDeps {
  now: () => Date;
  runArm: (arm: ArmSpec) => Promise<ArmResult>;
  propose: (input: Omit<ProposalInput, "prompt">) => Promise<Proposal>;
  redteam: () => Promise<{ suite: string; attacks: number; successes: number; asr: number }>;
  createStore: (seed: readonly Playbook[]) => PlaybookStore & { all(scope: "house"): Playbook[] };
  log: (line: string) => void;
}

export interface EvolutionOptions {
  mission: EvalMission;
  title: string;
  kind: EvolutionKind;
  trials: number;
  threshold: number;
  targetKey: PromptKey;
  target: PromptFile;
  nextPromptVersion: number;
  playbookKey: string;
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

function playbookRef(key: string, playbook: Playbook | null) {
  return {
    key,
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
  const id = `${stamp(startedAt)}-${options.mission}-${options.kind}`;
  const key = options.playbookKey;
  const parentPrompt = { name: options.target.name, version: options.target.version };
  const parentHouse = options.house;
  const pool = deps.createStore(parentHouse === null ? [] : [parentHouse]);
  const parentHouses: Houses = { [key]: parentHouse };

  deps.log(`Evolution ${id}: baseline arm with ${parentPrompt.name}@${parentPrompt.version}`);
  const baseline = await deps.runArm({
    label: "baseline",
    mission: options.mission,
    prompts: { [options.targetKey]: options.target },
    houses: parentHouses,
    store: readOnlyHouseStore(parentHouses, pool),
  });
  const pooled =
    pool.all("house").find((playbook) => playbook.key === key) ??
    emptyPlaybook(key, "house", startedAt.toISOString());

  let proposal: Proposal | undefined;
  let proposalError: string | undefined;
  try {
    proposal = await deps.propose({
      kind: options.kind,
      mission: { id: options.mission, title: options.title },
      targets: [options.target],
      digest: digestRows(baseline.trials.map(rowFromTrial)),
      pools: [pooled],
    });
  } catch (error) {
    if (!(error instanceof ProposalError)) throw error;
    proposalError = error.message;
  }

  const childPrompt =
    proposal?.kind === "prompt"
      ? candidatePrompt(options.target, proposal, `evolution ${id}`, options.nextPromptVersion)
      : options.target;
  const childHouse =
    proposal?.kind === "playbook"
      ? candidatePlaybook(pooled, proposal.keep, parentHouse)
      : parentHouse;

  let candidate: ArmResult | undefined;
  if (proposal !== undefined) {
    deps.log(
      `Evolution ${id}: candidate arm with ${childPrompt.name}@${childPrompt.version}, house playbook ${key} v${childHouse?.version ?? 0}`,
    );
    const childHouses: Houses = { [key]: childHouse };
    candidate = await deps.runArm({
      label: "candidate",
      mission: options.mission,
      prompts: { [options.targetKey]: childPrompt },
      houses: childHouses,
      store: readOnlyHouseStore(childHouses),
    });
  }
  const redteam = await deps.redteam();
  const decision = decideEvolution({
    baseline: armTrialsOf(baseline.trials.map(rowFromTrial)),
    candidate: armTrialsOf((candidate?.trials ?? []).map(rowFromTrial)),
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
        apply: `Point RUNTIME_PROMPT_FILES.${options.targetKey} at ${childPrompt.name}.v${childPrompt.version}.md in a reviewed commit.`,
      };
    } else if (childHouse !== null) {
      const file = join(options.playbooksDir, housePlaybookFileName(key));
      write(file, `${JSON.stringify(childHouse, null, 2)}\n`);
      promotion = { file };
    }
  }

  const log = EvolutionLogSchema.parse({
    version: EVOLUTION_LOG_VERSION,
    id,
    mission: options.mission,
    kind: options.kind,
    startedAt: startedAt.toISOString(),
    finishedAt: deps.now().toISOString(),
    trialsPerCase: options.trials,
    cases: baseline.summary.cases.map((row) => row.caseId),
    parent: { prompt: parentPrompt, playbook: playbookRef(key, parentHouse) },
    child: {
      prompt: { name: childPrompt.name, version: childPrompt.version },
      playbook: playbookRef(key, childHouse),
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
