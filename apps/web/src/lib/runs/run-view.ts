import {
  AUTOMATION_AUDIT_KIND,
  NEXT_ACTIONS_KIND,
  type NextAction,
  NextActionsSchema,
} from "@/lib/m2-contract";

import { auditCitationCheck, parseAudit } from "./audit";
import { briefStats, parseBrief } from "./brief";
import { buildLanes, type Lane } from "./lanes";
import { type PlanVersion, planVersions } from "./plan";

import {
  type AgentRole,
  type PlanStep,
  type FallbackReason,
  foldRun,
  type ModelRole,
  type PolicyDecisionKind,
  type RunEvent,
  type RunState,
  type ServingModel,
} from "@delegate/runtime";

export type StepViewStatus = "pending" | "running" | "done" | "failed";

export interface StepView {
  id: string;
  objective: string;
  role: AgentRole | null;
  status: StepViewStatus;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  summary: string | null;
  servedBy: ServingModel | null;
}

export type ActivityItem =
  | {
      kind: "message";
      key: string;
      seq: number;
      agentId: string;
      stepId: string | null;
      text: string;
    }
  | {
      kind: "tool";
      key: string;
      seq: number;
      stepId: string | null;
      toolCallId: string;
      tool: string;
      argsSummary: string;
      host: string | null;
      status: "running" | "ok" | "error";
      durationMs: number | null;
      summary: string | null;
      error: string | null;
    }
  | {
      kind: "policy";
      key: string;
      seq: number;
      tool: string;
      decision: PolicyDecisionKind;
      policyId: string;
      reason: string;
    }
  | {
      kind: "flag";
      key: string;
      seq: number;
      injection: boolean;
      severity: "info" | "warn" | "error";
      claim: string;
      reason: string;
      sourceId: string | null;
    }
  | {
      kind: "fallback";
      key: string;
      seq: number;
      role: ModelRole;
      from: ServingModel;
      to: ServingModel | null;
      reason: FallbackReason;
      retryAfterMs: number | null;
    }
  | {
      kind: "approval";
      key: string;
      seq: number;
      summary: string;
      reason: string;
      policyId: string;
    };

export type OutcomeKind =
  | "completed"
  | "failed"
  | "cancelled"
  | "budget"
  | "policy"
  | "capacity"
  | "site_unreachable"
  | "invalid_input"
  | "synthesis_invalid"
  | "plan_rejected"
  | "unsupported"
  | "worker_lost"
  | "runtime_unavailable";

export interface Outcome {
  kind: OutcomeKind;
  code: string | null;
  message: string;
  at: string;
}

export interface BriefArtifact {
  artifactId: string;
  title: string;
  version: number;
  contentVersion: number | null;
  content: unknown;
}

export interface ModelMixEntry {
  provider: string;
  model: string;
  calls: number;
  viaFallback: boolean;
  fellBackFrom: boolean;
}

export interface UsageView {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costMicroUsd: number;
  cacheHitRate: number | null;
}

export type CitationMetric =
  | { kind: "reported"; value: number; checked: number | null }
  | { kind: "resolved"; resolved: number; total: number };

export interface PlanApprovalView {
  version: number;
  auto: boolean;
  reason: string | null;
  at: string;
}

export type RunView =
  | {
      ok: true;
      state: RunState;
      missionId: string;
      target: string | null;
      url: string | null;
      execution: "live" | "simulated";
      createdAt: string;
      finishedAt: string | null;
      steps: StepView[];
      stepsDone: number;
      activity: ActivityItem[];
      usage: UsageView;
      providers: { provider: string }[];
      modelMix: ModelMixEntry[];
      outcome: Outcome | null;
      brief: BriefArtifact | null;
      audit: BriefArtifact | null;
      nextActions: NextAction[];
      planVersions: PlanVersion[];
      pendingPlan: { version: number; steps: PlanStep[] } | null;
      planApproval: PlanApprovalView | null;
      lanes: Lane[];
      citation: CitationMetric | null;
    }
  | { ok: false; error: string };

const URL_IN_TEXT = /https?:\/\/[^\s"'<>]+/i;
const DOMAIN_IN_TEXT = /\b((?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z]{2,63})(?=[/:\s]|$)/i;

export function hostFromSummary(text: string): string | null {
  const url = URL_IN_TEXT.exec(text)?.[0];
  if (url !== undefined) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return null;
    }
  }
  const domain = DOMAIN_IN_TEXT.exec(text)?.[1];
  return domain === undefined ? null : domain.toLowerCase().replace(/^www\./, "");
}

export function cacheHitRate(totals: {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}): number | null {
  if (totals.cacheReadTokens + totals.cacheWriteTokens === 0) return null;
  const prompt = totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
  return prompt === 0 ? null : totals.cacheReadTokens / prompt;
}

const BYOK_PROVIDERS = new Set(["anthropic"]);

export function costLabel(
  microUsd: number,
  providers: readonly { provider: string }[],
): { amount: string; note: "free tier" | "BYOK" | null } {
  const byok = providers.some((entry) => BYOK_PROVIDERS.has(entry.provider));
  const dollars = microUsd / 1_000_000;
  const amount =
    dollars === 0 || dollars >= 0.01 ? `$${dollars.toFixed(2)}` : `$${dollars.toFixed(3)}`;
  if (microUsd === 0 && !byok) return { amount, note: "free tier" };
  return { amount, note: byok ? "BYOK" : null };
}

export function modelMix(events: readonly RunEvent[]): ModelMixEntry[] {
  const entries = new Map<string, ModelMixEntry>();
  const entry = (served: ServingModel) => {
    const key = `${served.provider}\u0000${served.model}`;
    let found = entries.get(key);
    if (found === undefined) {
      found = {
        provider: served.provider,
        model: served.model,
        calls: 0,
        viaFallback: false,
        fellBackFrom: false,
      };
      entries.set(key, found);
    }
    return found;
  };
  for (const event of events) {
    if (event.type === "usage.updated") {
      entry({ provider: event.payload.provider, model: event.payload.model }).calls += 1;
    } else if (event.type === "model.fallback") {
      entry(event.payload.from).fellBackFrom = true;
      if (event.payload.to !== null) entry(event.payload.to).viaFallback = true;
    }
  }
  return [...entries.values()].sort(
    (a, b) =>
      b.calls - a.calls || `${a.provider}${a.model}`.localeCompare(`${b.provider}${b.model}`),
  );
}

const OUTCOME_BY_CODE: ReadonlyMap<string, OutcomeKind> = new Map([
  ["cancelled", "cancelled"],
  ["budget_exceeded", "budget"],
  ["no_model_available", "capacity"],
  ["site_unreachable", "site_unreachable"],
  ["invalid_input", "invalid_input"],
  ["synthesis_invalid", "synthesis_invalid"],
  ["plan_rejected", "plan_rejected"],
  ["invalid_plan", "plan_rejected"],
  ["no_supported_opportunities", "unsupported"],
  ["internal_error", "failed"],
  ["policy_denied", "policy"],
  ["worker_lost", "worker_lost"],
  ["runtime_unavailable", "runtime_unavailable"],
]);

export function classifyOutcome(error: { code: string; message: string }): {
  kind: OutcomeKind;
} {
  return { kind: OUTCOME_BY_CODE.get(error.code) ?? "failed" };
}

export function formatDuration(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < 60_000) return `${(Math.floor(safe / 100) / 10).toFixed(1)}s`;
  const totalSeconds = Math.floor(safe / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

export function elapsedMs(createdAt: string, finishedAt: string | null, now: number): number {
  const end = finishedAt === null ? now : Date.parse(finishedAt);
  return Math.max(0, end - Date.parse(createdAt));
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

export function buildActivity(events: readonly RunEvent[]): ActivityItem[] {
  const items: ActivityItem[] = [];
  const tools = new Map<string, number>();
  for (const event of events) {
    const last = items.at(-1);
    switch (event.type) {
      case "agent.message":
        if (last?.kind === "message" && last.agentId === event.agentId) {
          items[items.length - 1] = { ...last, text: last.text + event.payload.text };
        } else {
          items.push({
            kind: "message",
            key: `m${event.seq}`,
            seq: event.seq,
            agentId: event.agentId,
            stepId: event.stepId,
            text: event.payload.text,
          });
        }
        break;
      case "tool.called":
        tools.set(event.payload.toolCallId, items.length);
        items.push({
          kind: "tool",
          key: `t${event.seq}`,
          seq: event.seq,
          stepId: event.stepId,
          toolCallId: event.payload.toolCallId,
          tool: event.payload.tool,
          argsSummary: event.payload.argsSummary,
          host: hostFromSummary(event.payload.argsSummary),
          status: "running",
          durationMs: null,
          summary: null,
          error: null,
        });
        break;
      case "tool.result": {
        const index = tools.get(event.payload.toolCallId);
        const card = index === undefined ? undefined : items[index];
        if (index !== undefined && card?.kind === "tool") {
          items[index] = {
            ...card,
            status: event.payload.ok ? "ok" : "error",
            durationMs: event.payload.durationMs,
            summary: event.payload.summary,
            error: event.payload.error ?? null,
          };
        }
        break;
      }
      case "policy.decided":
        items.push({
          kind: "policy",
          key: `p${event.seq}`,
          seq: event.seq,
          tool: event.payload.tool,
          decision: event.payload.decision,
          policyId: event.payload.policyId,
          reason: event.payload.reason,
        });
        break;
      case "critic.flagged":
        items.push({
          kind: "flag",
          key: `f${event.seq}`,
          seq: event.seq,
          injection: event.payload.category === "injection_suspected",
          severity: event.payload.severity,
          claim: event.payload.claim,
          reason: event.payload.reason,
          sourceId: event.payload.sourceId ?? null,
        });
        break;
      case "model.fallback":
        items.push({
          kind: "fallback",
          key: `b${event.seq}`,
          seq: event.seq,
          role: event.payload.role,
          from: event.payload.from,
          to: event.payload.to,
          reason: event.payload.reason,
          retryAfterMs: event.payload.retryAfterMs ?? null,
        });
        break;
      case "approval.requested":
        items.push({
          kind: "approval",
          key: `a${event.seq}`,
          seq: event.seq,
          summary: event.payload.summary,
          reason: event.payload.reason,
          policyId: event.payload.policyId,
        });
        break;
      default:
        break;
    }
  }
  return items;
}

function latestBrief(events: readonly RunEvent[], state: RunState): BriefArtifact | null {
  return latestArtifact(
    events,
    state,
    (kind) => /brief|xray/i.test(kind) && kind !== "source-snapshot" && !kind.startsWith("repo-"),
  );
}

export function reportedCitationAccuracy(events: readonly RunEvent[]): CitationMetric | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "step.completed") continue;
    const report = event.payload.critic;
    if (report?.citationAccuracy === null || report?.citationAccuracy === undefined) continue;
    return { kind: "reported", value: report.citationAccuracy, checked: report.claimsChecked };
  }
  return null;
}

export function citationMetric(
  brief: BriefArtifact | null,
  audit: BriefArtifact | null,
  events: readonly RunEvent[] = [],
): CitationMetric | null {
  const reported = reportedCitationAccuracy(events);
  if (reported !== null) return reported;
  const artifact = audit ?? brief;
  if (artifact === null || artifact.content === null) return null;
  if (audit !== null) {
    const parsed = parseAudit(audit.content);
    if (!parsed.ok) return null;
    const check = auditCitationCheck(parsed.audit);
    return check.total === 0 ? null : { kind: "resolved", ...check };
  }
  const parsed = parseBrief(artifact.content);
  if (!parsed.ok) return null;
  const stats = briefStats(parsed.brief);
  return stats.citations === 0
    ? null
    : { kind: "resolved", resolved: stats.verifiedCitations, total: stats.citations };
}

function nextActionsOf(events: readonly RunEvent[], state: RunState): NextAction[] {
  const artifact = latestArtifact(events, state, (kind) => kind === NEXT_ACTIONS_KIND);
  if (artifact === null) return [];
  const parsed = NextActionsSchema.safeParse(artifact.content);
  return parsed.success ? parsed.data.actions : [];
}

function planApprovalOf(events: readonly RunEvent[]): PlanApprovalView | null {
  let approval: PlanApprovalView | null = null;
  for (const event of events) {
    if (event.type === "plan.approved") {
      approval = {
        version: event.payload.version,
        auto: event.payload.approvedBy.id === "auto-approve",
        reason: event.payload.reason ?? null,
        at: event.at,
      };
    }
  }
  return approval;
}

function latestArtifact(
  events: readonly RunEvent[],
  state: RunState,
  match: (kind: string) => boolean,
): BriefArtifact | null {
  const all = Object.values(state.artifacts);
  const chosen = all.find((artifact) => match(artifact.kind));
  if (chosen === undefined) return null;
  let content: unknown = null;
  let contentVersion: number | null = null;
  for (const event of events) {
    if (
      (event.type === "artifact.created" || event.type === "artifact.updated") &&
      event.payload.artifactId === chosen.artifactId &&
      event.payload.content !== undefined
    ) {
      content = event.payload.content;
      contentVersion = event.payload.version;
    }
  }
  return {
    artifactId: chosen.artifactId,
    title: chosen.title,
    version: chosen.version,
    contentVersion,
    content,
  };
}

function stepStatus(status: RunState["steps"][number]["status"]): StepViewStatus {
  if (status === "succeeded") return "done";
  return status;
}

export function buildRunView(events: readonly RunEvent[]): RunView {
  let state: RunState;
  try {
    state = foldRun(events);
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : "Unreadable event log" };
  }
  const created = events[0];
  if (created?.type !== "run.created") return { ok: false, error: "Missing run.created" };
  const input = created.payload.input;
  const url = typeof input.url === "string" ? input.url : null;
  let target: string | null = null;
  if (url !== null) {
    try {
      target = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      target = null;
    }
  }
  const objectives = new Map((state.plan?.steps ?? []).map((step) => [step.id, step]));
  const steps = state.steps.map((step): StepView => {
    const planned = objectives.get(step.id);
    return {
      id: step.id,
      objective: planned?.objective ?? step.id,
      role: planned?.role ?? null,
      status: stepStatus(step.status),
      startedAt: step.startedAt ?? null,
      completedAt: step.completedAt ?? null,
      durationMs:
        step.startedAt !== undefined && step.completedAt !== undefined
          ? Date.parse(step.completedAt) - Date.parse(step.startedAt)
          : null,
      summary: step.summary ?? null,
      servedBy: step.servedBy ?? null,
    };
  });
  const last = events.at(-1);
  const terminal = last?.type === "run.completed" || last?.type === "run.failed" ? last : null;
  let outcome: Outcome | null = null;
  if (terminal?.type === "run.completed") {
    outcome = { kind: "completed", code: null, message: terminal.payload.summary, at: terminal.at };
  } else if (terminal?.type === "run.failed") {
    outcome = {
      kind: classifyOutcome(terminal.payload.error).kind,
      code: terminal.payload.error.code,
      message: terminal.payload.error.message,
      at: terminal.at,
    };
  }
  const audit = latestArtifact(events, state, (kind) => kind === AUTOMATION_AUDIT_KIND);
  const brief = audit === null ? latestBrief(events, state) : null;
  const providers = events.flatMap((event) =>
    event.type === "usage.updated" ? [{ provider: event.payload.provider }] : [],
  );

  return {
    ok: true,
    state,
    missionId: created.payload.missionId,
    target,
    url,
    execution: input.execution === "simulated" ? "simulated" : "live",
    createdAt: created.at,
    finishedAt: terminal?.at ?? null,
    steps,
    stepsDone: steps.filter((step) => step.status === "done").length,
    activity: buildActivity(events),
    usage: {
      inputTokens: state.totals.inputTokens,
      outputTokens: state.totals.outputTokens,
      cachedTokens: state.totals.cacheReadTokens,
      costMicroUsd: state.totals.costMicroUsd,
      cacheHitRate: cacheHitRate(state.totals),
    },
    providers,
    modelMix: modelMix(events),
    outcome,
    brief,
    audit,
    nextActions: nextActionsOf(events, state),
    planVersions: planVersions(events),
    pendingPlan:
      state.status === "awaiting_plan_approval" && outcome === null && state.plan !== null
        ? { version: state.plan.version, steps: state.plan.steps }
        : null,
    planApproval: planApprovalOf(events),
    lanes: buildLanes(events),
    citation: citationMetric(brief, audit, events),
  };
}
