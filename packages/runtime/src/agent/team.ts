import { Budget, BudgetExceededError, totalTokens, type BudgetAmount } from "../budget";
import {
  type AgentRole,
  type ModelRole,
  type PlanStep,
  type PlanTeam,
  type TeamReducer,
  type Usage,
} from "../events";
import { type StepGrant } from "../tools/registry";
import { type Blackboard } from "./blackboard";
import { RunAbortedError, type RunContext } from "./context";
import {
  FatalStepError,
  SubAgentResultSchema,
  type AgentHandle,
  type Finding,
  type SubAgentResult,
} from "./subagent";

export const TEAM_LIMITS = {
  minSize: 2,
  maxSize: 6,
  maxMembersPerRun: 12,
  minMemberTokens: 2_000,
  maxMemberTokens: 60_000,
  minMemberMs: 5_000,
  maxMemberMs: 120_000,
  concurrency: 4,
} as const;

export interface TeamSupport {
  maxMembers: number;
  reducers: readonly TeamReducer[];
}

export function validateTeams(
  steps: readonly PlanStep[],
  supportOf: (stepId: string) => TeamSupport | undefined,
  ancestorsOf: (stepId: string) => ReadonlySet<string>,
): string[] {
  const issues: string[] = [];
  let members = 0;
  for (const step of steps) {
    const team = step.team;
    if (team === undefined) continue;
    members += team.size;
    const support = supportOf(step.id);
    if (support === undefined) {
      issues.push(`Step ${step.id} declares a team, but this step cannot run as a team`);
      continue;
    }
    const most = Math.min(TEAM_LIMITS.maxSize, support.maxMembers);
    if (team.size < TEAM_LIMITS.minSize || team.size > most)
      issues.push(
        `Step ${step.id} declares a team of ${team.size}; this step allows ${TEAM_LIMITS.minSize} to ${most} members`,
      );
    if (!support.reducers.includes(team.reducer))
      issues.push(`Step ${step.id} cannot merge its team with reducer ${team.reducer}`);
    if (
      team.memberTokens < TEAM_LIMITS.minMemberTokens ||
      team.memberTokens > TEAM_LIMITS.maxMemberTokens
    )
      issues.push(
        `Step ${step.id} gives each team member ${team.memberTokens} tokens; the allowed range is ${TEAM_LIMITS.minMemberTokens} to ${TEAM_LIMITS.maxMemberTokens}`,
      );
    if (team.memberMs < TEAM_LIMITS.minMemberMs || team.memberMs > TEAM_LIMITS.maxMemberMs)
      issues.push(
        `Step ${step.id} gives each team member ${team.memberMs} ms; the allowed range is ${TEAM_LIMITS.minMemberMs} to ${TEAM_LIMITS.maxMemberMs}`,
      );
    if (!ancestorsOf(step.id).has(team.from))
      issues.push(
        `Step ${step.id} derives its team from ${team.from}, which is not among its (transitive) inputs`,
      );
  }
  if (members > TEAM_LIMITS.maxMembersPerRun)
    issues.push(
      `The plan's teams have ${members} members in total; at most ${TEAM_LIMITS.maxMembersPerRun} are allowed per run`,
    );
  return issues;
}

function findingKey(finding: Finding): string {
  const citation = finding.citations[0];
  return citation === undefined || finding.quote === undefined
    ? `text:${finding.text}`
    : `quote:${citation}:${finding.quote}`;
}

export function mergeFindings(results: readonly SubAgentResult[]): SubAgentResult {
  const findings = new Map<string, Finding>();
  const sources = new Map<string, SubAgentResult["sources"][number]>();
  const artifacts = new Set<string>();
  for (const result of results) {
    for (const finding of result.findings) {
      const key = findingKey(finding);
      if (!findings.has(key)) findings.set(key, finding);
    }
    for (const source of result.sources)
      if (!sources.has(source.sourceId)) sources.set(source.sourceId, source);
    for (const artifact of result.artifacts) artifacts.add(artifact);
  }
  const confidence =
    results.length === 0
      ? 0
      : results.reduce((sum, result) => sum + result.confidence, 0) / results.length;
  return {
    summary: `${results.length} team member(s) finished: ${findings.size} finding(s) from ${sources.size} source(s)`,
    findings: [...findings.values()],
    sources: [...sources.values()],
    confidence,
    artifacts: [...artifacts],
  };
}

export const TEAM_REDUCERS: Record<
  TeamReducer,
  (results: readonly SubAgentResult[]) => SubAgentResult
> = {
  merge_findings: mergeFindings,
};

class MemberBudget extends Budget {
  private used = 0;

  constructor(
    private readonly parent: Budget,
    private readonly stepId: string,
    private readonly allowance: number,
  ) {
    super({ run: { maxTokens: 0, maxMicroUsd: 0 } });
  }

  override limits(stepId: string) {
    return this.parent.limits(stepId);
  }

  override spent(stepId?: string): BudgetAmount {
    return this.parent.spent(stepId);
  }

  override remaining(stepId?: string): BudgetAmount {
    const parent = this.parent.remaining(stepId ?? this.stepId);
    return {
      tokens: Math.min(parent.tokens, Math.max(0, this.allowance - this.used)),
      microUsd: parent.microUsd,
    };
  }

  override charge(usage: Usage, stepId?: string): void {
    this.used += totalTokens(usage);
    this.parent.charge(usage, stepId ?? this.stepId);
    if (this.used > this.allowance)
      throw new BudgetExceededError("step", "tokens", this.allowance, this.used, this.stepId);
  }
}

export interface TeamAssignment {
  id: string;
  objective: string;
  capabilities?: readonly string[];
}

export interface TeamMember {
  index: number;
  assignment: TeamAssignment;
  agent: AgentHandle;
  grant: StepGrant;
  ctx: RunContext;
  deadlineAt: number;
  blackboard: () => Blackboard;
}

export type TeamMemberStatus = "finished" | "failed" | "timed_out" | "over_budget" | "not_started";

export interface TeamMemberOutcome {
  assignment: TeamAssignment;
  status: TeamMemberStatus;
  result?: SubAgentResult;
}

export interface TeamOutcome {
  result: SubAgentResult;
  members: TeamMemberOutcome[];
}

export interface TeamRunOptions {
  assignments: readonly TeamAssignment[];
  role: AgentRole;
  modelRole: ModelRole;
  member: (member: TeamMember) => Promise<SubAgentResult>;
  reduce?: (results: readonly SubAgentResult[]) => SubAgentResult;
  ctx?: RunContext;
}

export interface TeamHandle {
  declared: PlanTeam;
  run: (options: TeamRunOptions) => Promise<TeamOutcome>;
}

export interface TeamCounter {
  spawned: number;
}

export interface TeamHandleOptions {
  ctx: RunContext;
  step: PlanStep;
  team: PlanTeam;
  grant: StepGrant;
  spawn: (role: AgentRole, modelRole: ModelRole) => Promise<AgentHandle>;
  blackboard: () => Blackboard;
  counter: TeamCounter;
}

const TIMED_OUT = Symbol("timed-out");
const TEAM_ABORT_GRACE_MS = 2_000;

function isFatal(error: unknown): boolean {
  return (
    error instanceof FatalStepError ||
    (error instanceof BudgetExceededError && error.scope === "run")
  );
}

function memberGrant(grant: StepGrant, assignment: TeamAssignment): StepGrant {
  const wanted = assignment.capabilities;
  return {
    id: grant.id,
    capabilities:
      wanted === undefined
        ? [...grant.capabilities]
        : grant.capabilities.filter((capability) => wanted.includes(capability)),
  };
}

export function createTeamHandle(options: TeamHandleOptions): TeamHandle {
  const { step, team, counter } = options;

  const runMember = async (
    run: TeamRunOptions,
    assignment: TeamAssignment,
    index: number,
    total: number,
  ): Promise<TeamMemberOutcome> => {
    const base = run.ctx ?? options.ctx;
    const agent = await options.spawn(run.role, run.modelRole);
    await agent.say(`Team member ${index + 1} of ${total}: ${assignment.objective}`.slice(0, 600));
    const deadline = new AbortController();
    const signal =
      base.signal === undefined ? deadline.signal : AbortSignal.any([base.signal, deadline.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => {
        deadline.abort();
        resolve(TIMED_OUT);
      }, team.memberMs);
    });
    const work = run.member({
      index,
      assignment,
      agent,
      grant: memberGrant(options.grant, assignment),
      ctx: { ...base, signal, budget: new MemberBudget(base.budget, step.id, team.memberTokens) },
      deadlineAt: base.now().getTime() + team.memberMs,
      blackboard: options.blackboard,
    });
    try {
      const raw = await Promise.race([work, expired]);
      if (raw === TIMED_OUT) {
        await Promise.race([work.catch(() => undefined), base.sleep(TEAM_ABORT_GRACE_MS)]).catch(
          () => undefined,
        );
        if (base.signal?.aborted === true) throw new RunAbortedError();
        await agent.say(`Stopped: no result within ${Math.round(team.memberMs / 1000)} s.`);
        return { assignment, status: "timed_out" };
      }
      return { assignment, status: "finished", result: SubAgentResultSchema.parse(raw) };
    } catch (error) {
      if (base.signal?.aborted === true) throw new RunAbortedError();
      if (isFatal(error)) throw error;
      if (deadline.signal.aborted) {
        await agent.say(`Stopped: no result within ${Math.round(team.memberMs / 1000)} s.`);
        return { assignment, status: "timed_out" };
      }
      if (error instanceof BudgetExceededError) {
        await agent.say(`Stopped: this member used its ${team.memberTokens} token allowance.`);
        return { assignment, status: "over_budget" };
      }
      await agent.say("This team member failed; the others continue.");
      return { assignment, status: "failed" };
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    declared: team,
    async run(run) {
      const allowed = Math.max(
        0,
        Math.min(team.size, TEAM_LIMITS.maxMembersPerRun - counter.spawned),
      );
      const started = run.assignments.slice(0, allowed);
      counter.spawned += started.length;
      const outcomes = new Array<TeamMemberOutcome | undefined>(started.length);
      let next = 0;
      const worker = async () => {
        for (;;) {
          const index = next;
          next += 1;
          const assignment = started[index];
          if (assignment === undefined) return;
          outcomes[index] = await runMember(run, assignment, index, started.length);
        }
      };
      const pool = Array.from({ length: Math.min(TEAM_LIMITS.concurrency, started.length) }, () =>
        worker(),
      );
      const settled = await Promise.allSettled(pool);
      for (const entry of settled)
        if (entry.status === "rejected")
          throw entry.reason instanceof Error ? entry.reason : new Error("A team member failed");
      const members: TeamMemberOutcome[] = [
        ...outcomes.flatMap((outcome) => (outcome === undefined ? [] : [outcome])),
        ...run.assignments
          .slice(allowed)
          .map((assignment) => ({ assignment, status: "not_started" as const })),
      ];
      const finished = members.flatMap((member) =>
        member.result === undefined ? [] : [member.result],
      );
      const reduce = run.reduce ?? TEAM_REDUCERS[team.reducer];
      return { result: SubAgentResultSchema.parse(reduce(finished)), members };
    },
  };
}
