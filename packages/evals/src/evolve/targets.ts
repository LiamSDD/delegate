import { type RuntimePrompts } from "@delegate/runtime/server";

import { EVAL_MISSIONS, type EvalMission } from "../results";

export type PromptKey = keyof RuntimePrompts;

export interface MissionTargets {
  mission: EvalMission;
  runtimeMissionId: string;
  hardChecks: readonly string[];
  regression: { threshold: number; metrics: readonly ("score" | "judge" | "cost")[] };
  runtimePrompts: readonly PromptKey[];
  prompts: readonly PromptKey[];
  playbooks: "mission" | "goal-category";
}

const REGRESSION = { threshold: 0.05, metrics: ["score", "judge", "cost"] } as const;

export const MISSION_TARGETS: Record<EvalMission, MissionTargets> = {
  xray: {
    mission: "xray",
    runtimeMissionId: "company-xray",
    hardChecks: [
      "run_completed",
      "schema_valid",
      "claims_cited",
      "citations_resolve",
      "quotes_in_sources",
    ],
    regression: REGRESSION,
    runtimePrompts: ["reader", "researcher", "synthesis"],
    prompts: ["synthesis"],
    playbooks: "mission",
  },
  audit: {
    mission: "audit",
    runtimeMissionId: "automation-audit",
    hardChecks: ["run_completed", "schema_valid", "opportunity_count", "citations_resolve"],
    regression: REGRESSION,
    runtimePrompts: [
      "planner",
      "reader",
      "researcher",
      "analyst",
      "auditEditor",
      "critic",
      "editor",
    ],
    prompts: ["analyst", "auditEditor"],
    playbooks: "mission",
  },
  build: {
    mission: "build",
    runtimeMissionId: "build-agent",
    hardChecks: [
      "run_completed",
      "schema_valid",
      "out_of_scope_refused",
      "answers_cited",
      "citations_on_site",
    ],
    regression: REGRESSION,
    runtimePrompts: [
      "planner",
      "designer",
      "evalgen",
      "grader",
      "gaps",
      "answer",
      "rerank",
      "critic",
      "editor",
    ],
    prompts: ["designer"],
    playbooks: "goal-category",
  },
  repo: {
    mission: "repo",
    runtimeMissionId: "repo-xray",
    hardChecks: [
      "run_completed",
      "schema_valid",
      "citations_resolve",
      "mermaid_nodes_real",
      "improvements_valid",
    ],
    regression: REGRESSION,
    runtimePrompts: ["planner", "reader", "repoArchitect", "repoImprover", "critic", "editor"],
    prompts: ["repoArchitect", "repoImprover"],
    playbooks: "mission",
  },
  goal: {
    mission: "goal",
    runtimeMissionId: "custom-goal",
    hardChecks: [
      "run_completed",
      "plan_valid",
      "schema_valid",
      "claims_cited",
      "action_plan_present",
    ],
    regression: REGRESSION,
    runtimePrompts: [
      "planner",
      "reader",
      "researcher",
      "goalSynthesis",
      "goalConnectors",
      "critic",
      "editor",
      "goalCoverage",
    ],
    prompts: ["goalSynthesis"],
    playbooks: "goal-category",
  },
};

export const SHARED_PROMPTS: readonly PromptKey[] = [
  "planner",
  "reader",
  "researcher",
  "critic",
  "editor",
  "rerank",
  "reflect",
];

export function missionTargets(mission: EvalMission): MissionTargets {
  return MISSION_TARGETS[mission];
}

export function isEvalMission(value: string): value is EvalMission {
  return (EVAL_MISSIONS as readonly string[]).includes(value);
}

export interface GateSummaryView {
  mission: EvalMission;
  overall: {
    trials: number;
    errored: number;
    hardFailures: number;
    checkPassRates: Record<string, { passed: number; counted: number }>;
  };
  regressions: readonly {
    scope: string;
    metric: "score" | "judge" | "cost";
    worsening?: number;
    pValue?: number;
  }[];
}

export interface MissionGateVerdict {
  mission: EvalMission;
  ok: boolean;
  message: string;
  failedHardChecks: { kind: string; failed: number; counted: number }[];
}

export function missionGateVerdict(summary: GateSummaryView): MissionGateVerdict {
  const rules = missionTargets(summary.mission);
  const reasons: string[] = [];
  const failedHardChecks = rules.hardChecks.flatMap((kind) => {
    const rate = summary.overall.checkPassRates[kind];
    return rate === undefined || rate.passed === rate.counted
      ? []
      : [{ kind, failed: rate.counted - rate.passed, counted: rate.counted }];
  });
  if (failedHardChecks.length > 0)
    reasons.push(
      `hard checks failed: ${failedHardChecks.map((row) => `${row.kind} ${row.failed}/${row.counted}`).join(", ")}`,
    );
  else if (summary.overall.hardFailures > 0)
    reasons.push(`${summary.overall.hardFailures} trial(s) failed a hard check`);
  for (const regression of summary.regressions) {
    if (!rules.regression.metrics.includes(regression.metric)) continue;
    reasons.push(
      `${regression.scope} ${regression.metric} regressed by ${regression.worsening?.toFixed(3) ?? "?"} (p=${regression.pValue?.toFixed(3) ?? "?"})`,
    );
  }
  if (summary.overall.trials > 0 && summary.overall.errored === summary.overall.trials)
    reasons.push("every trial errored on infrastructure, so there is no evidence either way");
  return {
    mission: summary.mission,
    ok: reasons.length === 0,
    failedHardChecks,
    message:
      reasons.length === 0
        ? `passed: ${summary.overall.trials} trials, ${summary.overall.errored} errored, no hard failures or meaningful regressions`
        : `failed: ${reasons.join("; ")}`,
  };
}
