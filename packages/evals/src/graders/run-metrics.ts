import { type ModelRole, type RunEvent } from "@delegate/runtime";
import { z } from "zod";

export const INFRASTRUCTURE_FAILURES: readonly string[] = [
  "no_model_available",
  "site_unreachable",
  "cancelled",
];

export interface GradedCheck {
  kind: string;
  passed: boolean;
  severity: "hard" | "soft";
  skipped?: boolean;
  detail?: string;
}

export interface ServingRecord {
  role: ModelRole;
  provider: string;
  model: string;
  calls: number;
}

export interface RunMetrics {
  latencyMs: number;
  costMicroUsd: number;
  totalTokens: number;
  toolsUsed: string[];
  toolCalls: number;
  redundantFetches: number;
  policyDenials: number;
  injectionFlags: number;
  fallbacks: number;
}

export interface BudgetTargets {
  maxLatencyMs: number;
  maxCostMicroUsd: number;
  maxTokens: number;
}

export type RunOutcome = "completed" | "failed" | "errored";

export function runOutcome(events: readonly RunEvent[]): {
  outcome: RunOutcome;
  failureCode?: string;
} {
  const failed = events.find((event) => event.type === "run.failed");
  const completed = events.some((event) => event.type === "run.completed");
  const failureCode = failed?.type === "run.failed" ? failed.payload.error.code : undefined;
  const outcome: RunOutcome = completed
    ? "completed"
    : failureCode !== undefined && INFRASTRUCTURE_FAILURES.includes(failureCode)
      ? "errored"
      : "failed";
  return { outcome, ...(failureCode === undefined ? {} : { failureCode }) };
}

export function normaliseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return `${parsed.host.replace(/^www\./, "")}${parsed.pathname.replace(/\/+$/, "")}${parsed.search}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

export function servingFrom(events: readonly RunEvent[]): ServingRecord[] {
  const roleByStep = new Map<string, ModelRole>();
  const counts = new Map<string, ServingRecord>();
  for (const event of events) {
    if (event.type === "agent.spawned") roleByStep.set(event.stepId, event.payload.modelRole);
    if (event.type !== "usage.updated") continue;
    const role =
      (event.stepId === undefined ? undefined : roleByStep.get(event.stepId)) ?? "worker";
    const key = `${role}\u0000${event.payload.provider}\u0000${event.payload.model}`;
    const existing = counts.get(key);
    counts.set(
      key,
      existing === undefined
        ? { role, provider: event.payload.provider, model: event.payload.model, calls: 1 }
        : { ...existing, calls: existing.calls + 1 },
    );
  }
  return [...counts.values()].sort(
    (a, b) =>
      a.role.localeCompare(b.role) ||
      a.provider.localeCompare(b.provider) ||
      a.model.localeCompare(b.model),
  );
}

function fetchKey(event: RunEvent): string | undefined {
  if (event.type !== "tool.called" || event.payload.tool !== "fetch_page") return undefined;
  try {
    const args = z.object({ url: z.string() }).safeParse(JSON.parse(event.payload.argsSummary));
    return args.success ? normaliseUrl(args.data.url) : undefined;
  } catch {
    return undefined;
  }
}

export function policyDenials(events: readonly RunEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === "policy.decided" && event.payload.decision === "deny"
      ? [`${event.payload.tool}: ${event.payload.reason.slice(0, 80)}`]
      : [],
  );
}

export function runMetrics(events: readonly RunEvent[]): RunMetrics {
  const first = events[0];
  const last = events.at(-1);
  let costMicroUsd = 0;
  let totalTokens = 0;
  for (const event of events) {
    if (event.type !== "usage.updated") continue;
    costMicroUsd += event.payload.costMicroUsd;
    totalTokens += event.payload.inputTokens + event.payload.outputTokens;
  }
  let redundantFetches = 0;
  const seen = new Set<string>();
  for (const event of events) {
    const key = fetchKey(event);
    if (key === undefined) continue;
    if (seen.has(key)) redundantFetches += 1;
    seen.add(key);
  }
  return {
    latencyMs:
      first === undefined || last === undefined ? 0 : Date.parse(last.at) - Date.parse(first.at),
    costMicroUsd,
    totalTokens,
    toolsUsed: [
      ...new Set(
        events.flatMap((event) => (event.type === "tool.called" ? [event.payload.tool] : [])),
      ),
    ].sort(),
    toolCalls: events.filter((event) => event.type === "tool.called").length,
    redundantFetches,
    policyDenials: policyDenials(events).length,
    injectionFlags: events.filter(
      (event) =>
        event.type === "critic.flagged" && event.payload.category === "injection_suspected",
    ).length,
    fallbacks: events.filter((event) => event.type === "model.fallback").length,
  };
}

export function budgetChecks(metrics: RunMetrics, targets: BudgetTargets): GradedCheck[] {
  return [
    {
      kind: "max_latency_ms",
      severity: "soft",
      passed: metrics.latencyMs <= targets.maxLatencyMs,
      detail: `${(metrics.latencyMs / 1000).toFixed(1)} s (target < ${targets.maxLatencyMs / 1000} s)`,
    },
    {
      kind: "max_cost_micro_usd",
      severity: "soft",
      passed: metrics.costMicroUsd <= targets.maxCostMicroUsd,
      detail: `${metrics.costMicroUsd} micro-USD (max ${targets.maxCostMicroUsd})`,
    },
    {
      kind: "within_token_budget",
      severity: "soft",
      passed: metrics.totalTokens <= targets.maxTokens,
      detail: `${metrics.totalTokens} tokens (max ${targets.maxTokens})`,
    },
  ];
}

export function hygieneChecks(events: readonly RunEvent[], metrics: RunMetrics): GradedCheck[] {
  const denials = policyDenials(events);
  return [
    {
      kind: "no_redundant_fetches",
      severity: "soft",
      passed: metrics.redundantFetches === 0,
      detail: `${metrics.redundantFetches} repeated fetch_page URLs`,
    },
    {
      kind: "no_policy_denials",
      severity: "soft",
      passed: denials.length === 0,
      detail: denials.length === 0 ? "0 denials" : `denied: ${denials.slice(0, 3).join(", ")}`,
    },
  ];
}

export function lastArtifactContent(events: readonly RunEvent[], kind: string): unknown {
  const ids = new Set<string>();
  let content: unknown;
  for (const event of events) {
    if (event.type === "artifact.created" && event.payload.kind === kind) {
      ids.add(event.payload.artifactId);
      content = event.payload.content;
    }
    if (
      event.type === "artifact.updated" &&
      ids.has(event.payload.artifactId) &&
      event.payload.content !== undefined
    )
      content = event.payload.content;
  }
  return content;
}

export function hardFailuresOf(outcome: RunOutcome, checks: readonly GradedCheck[]): string[] {
  return outcome === "errored"
    ? []
    : checks.filter((entry) => entry.severity === "hard" && !entry.passed).map((e) => e.kind);
}

export function checkScore(checks: readonly GradedCheck[]): number {
  const counted = checks.filter((entry) => entry.skipped !== true);
  if (counted.length === 0) return 0;
  return counted.filter((entry) => entry.passed).length / counted.length;
}
