import { type EvalResultFile } from "../results";
import { wilsonInterval } from "../stats";
import {
  LEARNED_ROUTING_VERSION,
  LearnedRoutingSchema,
  ROUTING_ROLES,
  type LearnedEntry,
  type LearnedModel,
  type LearnedRouting,
  type RoutingRole,
} from "./schema";

export const ROUTE_LEARN_DEFAULTS = { minTrials: 20 } as const;

export interface ModelRef {
  provider: string;
  model: string;
}

export type RoleChains = Record<RoutingRole, readonly ModelRef[]>;

export interface RoutingSource {
  path: string;
  file: EvalResultFile;
}

export interface LearnRoutingInput {
  sources: readonly RoutingSource[];
  chains: RoleChains;
  missionIds: Readonly<Record<string, string>>;
  minTrials?: number;
  now: Date;
}

interface ModelStats extends ModelRef {
  trials: number;
  passes: number;
  latencies: number[];
}

interface RoleEvidence {
  models: Map<string, ModelStats>;
  mixed: number;
  unattributable: number;
  unused: number;
}

function keyOf(model: ModelRef): string {
  return `${model.provider}\u0000${model.model}`;
}

function label(model: ModelRef): string {
  return `${model.provider}/${model.model}`;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[middle - 1] ?? upper) + upper) / 2;
}

function emptyEvidence(): RoleEvidence {
  return { models: new Map(), mixed: 0, unattributable: 0, unused: 0 };
}

function credit(
  evidence: RoleEvidence,
  model: ModelRef,
  trial: { passed: boolean; latencyMs: number },
): void {
  const key = keyOf(model);
  const stats = evidence.models.get(key) ?? {
    provider: model.provider,
    model: model.model,
    trials: 0,
    passes: 0,
    latencies: [],
  };
  stats.trials += 1;
  stats.passes += trial.passed ? 1 : 0;
  stats.latencies.push(trial.latencyMs);
  evidence.models.set(key, stats);
}

export function isRoutingEvidence(file: EvalResultFile): boolean {
  return file.mode === "live";
}

function collect(file: EvalResultFile, role: RoutingRole, evidence: RoleEvidence): number {
  const aggregate = file.models.filter((entry) => entry.role === role);
  let counted = 0;
  for (const trial of file.cases.flatMap((entry) => entry.trials)) {
    if (trial.outcome === "errored") continue;
    counted += 1;
    if (trial.hardFailures === undefined) {
      const [only, ...rest] = aggregate;
      if (only === undefined) evidence.unused += 1;
      else if (rest.length === 0) credit(evidence, only, trial);
      else evidence.unattributable += 1;
      continue;
    }
    const calls = (trial.serving ?? []).filter((entry) => entry.role === role);
    const total = calls.reduce((sum, entry) => sum + entry.calls, 0);
    if (total === 0) {
      evidence.unused += 1;
      continue;
    }
    const byModel = new Map<string, { ref: ModelRef; calls: number }>();
    for (const entry of calls) {
      const current = byModel.get(keyOf(entry));
      byModel.set(keyOf(entry), {
        ref: { provider: entry.provider, model: entry.model },
        calls: (current?.calls ?? 0) + entry.calls,
      });
    }
    const dominant = [...byModel.values()].find((entry) => entry.calls * 2 > total);
    if (dominant === undefined) evidence.mixed += 1;
    else credit(evidence, dominant.ref, trial);
  }
  return counted;
}

function toLearned(stats: ModelStats): LearnedModel {
  const interval = wilsonInterval(stats.passes, stats.trials);
  return {
    provider: stats.provider,
    model: stats.model,
    trials: stats.trials,
    passRate: interval.rate,
    ci: [interval.lower, interval.upper],
    p50LatencyMs: median(stats.latencies),
  };
}

function byEvidence(a: LearnedModel, b: LearnedModel): number {
  return (
    b.passRate - a.passRate ||
    b.ci[0] - a.ci[0] ||
    b.trials - a.trials ||
    label(a).localeCompare(label(b))
  );
}

function describe(model: LearnedModel): string {
  return `${label(model)} (n=${model.trials}, ${(model.passRate * 100).toFixed(0)}% [${(model.ci[0] * 100).toFixed(0)}, ${(model.ci[1] * 100).toFixed(0)}])`;
}

export interface RoutingDecision {
  decision: LearnedEntry["decision"];
  order: LearnedModel[];
  reason: string;
}

export function decideRouting(
  observed: readonly LearnedModel[],
  configured: readonly ModelRef[],
  minTrials: number,
): RoutingDecision {
  const position = new Map(configured.map((model, index) => [keyOf(model), index]));
  const ranked = [...observed].sort(byEvidence);
  const routable = ranked.filter((model) => position.has(keyOf(model)));
  const retired = ranked.filter((model) => !position.has(keyOf(model)));
  const sampled = routable.filter((model) => model.trials >= minTrials);
  const thin = routable.filter((model) => model.trials < minTrials);
  const retiredNote =
    retired.length === 0
      ? ""
      : ` Not ranked because config/models.json no longer lists ${retired.length === 1 ? "it" : "them"} for this role: ${retired.map(describe).join(", ")}.`;
  const insufficient = (reason: string): RoutingDecision => ({
    decision: "insufficient-evidence",
    order: [...sampled, ...thin, ...retired],
    reason: `${reason}${retiredNote}`,
  });
  if (ranked.length === 0) return insufficient("No trial could be attributed to a model.");
  const [best, second] = sampled;
  if (best === undefined) {
    const most = [...routable].sort((a, b) => b.trials - a.trials || byEvidence(a, b))[0];
    return insufficient(
      most === undefined
        ? "No observed model is configured for this role."
        : `No model has ${minTrials} attributed trials; the most observed is ${describe(most)}.`,
    );
  }
  if (second === undefined)
    return insufficient(
      `Only ${describe(best)} has ${minTrials} attributed trials, so there is nothing to compare it with${thin.length === 0 ? "" : `; below the minimum: ${thin.map(describe).join(", ")}`}.`,
    );

  const stats = new Map(routable.map((model) => [keyOf(model), model]));
  const listed: LearnedModel[] = [];
  const separations: string[] = [];
  let stop = "";
  for (const [index, candidate] of sampled.entries()) {
    const overlapping = sampled.slice(index + 1).find((other) => candidate.ci[0] <= other.ci[1]);
    if (overlapping !== undefined) {
      stop = `${describe(candidate)} and ${describe(overlapping)} are not separated: their intervals overlap.`;
      break;
    }
    const listedKeys = new Set(listed.map(keyOf));
    const unmeasuredAhead = configured
      .slice(0, position.get(keyOf(candidate)) ?? 0)
      .find((ahead) => {
        if (listedKeys.has(keyOf(ahead))) return false;
        const known = stats.get(keyOf(ahead));
        return known === undefined || known.trials < minTrials;
      });
    if (unmeasuredAhead !== undefined) {
      const known = stats.get(keyOf(unmeasuredAhead));
      stop = `${label(unmeasuredAhead)} is configured ahead of ${label(candidate)} and has ${known === undefined ? "no attributed trials" : `only ${known.trials} attributed trial${known.trials === 1 ? "" : "s"}`} (minimum ${minTrials}), so moving ${label(candidate)} ahead of it is not supported.`;
      break;
    }
    const next = sampled[index + 1];
    if (next !== undefined) separations.push(`${describe(candidate)} is above ${describe(next)}`);
    listed.push(candidate);
  }
  if (listed.length === 0) return insufficient(stop);
  const unlisted = routable.length - listed.length;
  const kept =
    unlisted === 0
      ? ""
      : ` ${unlisted} other observed model${unlisted === 1 ? " keeps its" : "s keep their"} configured order${stop === "" ? " (below the minimum number of trials)" : `: ${stop}`}`;
  return {
    decision: "learned",
    order: listed,
    reason: `${separations.length === 0 ? `${describe(best)} leads` : separations.join("; ")}.${kept}${kept === "" || kept.endsWith(".") ? "" : "."}${retiredNote}`,
  };
}

function attributionNote(evidence: RoleEvidence): string {
  const notes: string[] = [];
  if (evidence.unattributable > 0)
    notes.push(
      `${evidence.unattributable} trial${evidence.unattributable === 1 ? "" : "s"} from result files without per-trial serving could not be attributed (several models served the role)`,
    );
  if (evidence.mixed > 0)
    notes.push(
      `${evidence.mixed} trial${evidence.mixed === 1 ? " was" : "s were"} served by several models with no majority`,
    );
  return notes.length === 0 ? "" : ` Not counted: ${notes.join("; ")}.`;
}

export function learnRouting(input: LearnRoutingInput): LearnedRouting {
  const minTrials = input.minTrials ?? ROUTE_LEARN_DEFAULTS.minTrials;
  const used = input.sources
    .filter((source) => isRoutingEvidence(source.file))
    .sort((a, b) => a.path.localeCompare(b.path));
  const missions = [...new Set(used.map((source) => source.file.mission))];
  const order = Object.keys(input.missionIds);
  missions.sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib) || a.localeCompare(b);
  });
  let trials = 0;
  const entries: LearnedEntry[] = [];
  for (const mission of missions) {
    const files = used.filter((source) => source.file.mission === mission);
    for (const [index, role] of ROUTING_ROLES.entries()) {
      const evidence = emptyEvidence();
      let counted = 0;
      for (const source of files) counted += collect(source.file, role, evidence);
      if (index === 0) trials += counted;
      const observed = [...evidence.models.values()].map(toLearned);
      const decision =
        observed.length === 0 && evidence.unattributable === 0 && evidence.mixed === 0
          ? {
              decision: "insufficient-evidence" as const,
              order: [],
              reason:
                counted === 0
                  ? "Every trial errored on infrastructure."
                  : `The ${role} role made no model call in ${counted} trial${counted === 1 ? "" : "s"}.`,
            }
          : decideRouting(observed, input.chains[role], minTrials);
      entries.push({
        mission: input.missionIds[mission] ?? mission,
        role,
        order: decision.order,
        decision: decision.decision,
        reason: `${decision.reason}${attributionNote(evidence)}`,
      });
    }
  }
  return LearnedRoutingSchema.parse({
    version: LEARNED_ROUTING_VERSION,
    generatedAt: input.now.toISOString(),
    source: { resultFiles: used.map((source) => source.path), trials },
    minTrials,
    entries,
  });
}

export function renderRouting(routing: LearnedRouting): string {
  const lines = [
    `Learned routing from ${routing.source.resultFiles.length} live result file(s), ${routing.source.trials} graded trials; minimum ${routing.minTrials} trials per model.`,
  ];
  for (const entry of routing.entries) {
    lines.push(`${entry.mission} ${entry.role}: ${entry.decision}`);
    for (const model of entry.order)
      lines.push(
        `  ${describe(model)}${model.p50LatencyMs === null ? "" : `, trial p50 ${(model.p50LatencyMs / 1000).toFixed(1)} s`}`,
      );
    lines.push(`  ${entry.reason}`);
  }
  return lines.join("\n");
}
