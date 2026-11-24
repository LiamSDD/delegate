import {
  CompanyXrayBriefSchema,
  SECTION_KEYS,
  type ModelRole,
  type RunEvent,
} from "@delegate/runtime";
import { z } from "zod";

export interface XrayTargets {
  maxLatencyMs: number;
  maxCostMicroUsd: number;
  maxTokens: number;
  minCitations: number;
  minSectionsCovered: number;
  requiredTools: readonly string[];
}

export const DEFAULT_XRAY_TARGETS: XrayTargets = {
  maxLatencyMs: 90_000,
  maxCostMicroUsd: 0,
  maxTokens: 300_000,
  minCitations: 5,
  minSectionsCovered: 4,
  requiredTools: ["crawl_site"],
};

export const HARD_CHECKS = [
  "run_completed",
  "schema_valid",
  "claims_cited",
  "citations_resolve",
  "quotes_in_sources",
] as const;

export const INFRASTRUCTURE_FAILURES: readonly string[] = [
  "no_model_available",
  "site_unreachable",
  "cancelled",
];

export interface LinkStatus {
  ok: boolean;
  status?: number;
  error?: string;
}

export interface GradedCheck {
  kind: string;
  passed: boolean;
  severity: "hard" | "soft";
  skipped?: boolean;
  detail?: string;
}

export interface XrayMetrics {
  claims: number;
  citations: number;
  sources: number;
  sectionsCovered: number;
  sectionsInsufficient: number;
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

export interface ServingRecord {
  role: ModelRole;
  provider: string;
  model: string;
  calls: number;
}

export interface XrayGrade {
  outcome: "completed" | "failed" | "errored";
  failureCode?: string;
  checks: GradedCheck[];
  hardFailures: string[];
  metrics: XrayMetrics;
  serving: ServingRecord[];
  brief: unknown;
}

export interface GradeInput {
  events: readonly RunEvent[];
  targets: XrayTargets;
  links?: ReadonlyMap<string, LinkStatus>;
}

interface LooseClaim {
  text: string;
  citations: string[];
}

const SnapshotSchema = z.object({
  sources: z.array(
    z.object({
      sourceId: z.string(),
      url: z.string(),
      text: z.string(),
      hiddenText: z.array(z.string()).default([]),
    }),
  ),
});

const LooseBriefSchema = z.object({
  company: z.object({ oneLiner: z.unknown() }).partial().optional(),
  sources: z
    .array(
      z.object({
        sourceId: z.string(),
        url: z.string(),
        quotes: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  sections: z.record(z.string(), z.unknown()).default({}),
});
type LooseBrief = z.infer<typeof LooseBriefSchema>;

export function normaliseText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normaliseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return `${parsed.host.replace(/^www\./, "")}${parsed.pathname.replace(/\/+$/, "")}${parsed.search}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

function collectClaims(value: unknown, into: LooseClaim[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectClaims(item, into);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") {
    const citations = Array.isArray(record.citations)
      ? record.citations.filter((entry): entry is string => typeof entry === "string")
      : [];
    into.push({ text: record.text, citations });
    return;
  }
  for (const nested of Object.values(record)) collectClaims(nested, into);
}

export function finalBrief(events: readonly RunEvent[]): unknown {
  const briefIds = new Set(
    events.flatMap((event) =>
      event.type === "artifact.created" && event.payload.kind === "company-xray-brief"
        ? [event.payload.artifactId]
        : [],
    ),
  );
  let latest: unknown;
  for (const event of events) {
    if (
      (event.type === "artifact.created" || event.type === "artifact.updated") &&
      briefIds.has(event.payload.artifactId)
    )
      latest = event.payload.content;
  }
  return latest;
}

function looseBrief(raw: unknown): LooseBrief | undefined {
  const parsed = LooseBriefSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

function briefClaims(brief: LooseBrief | undefined): LooseClaim[] {
  const claims: LooseClaim[] = [];
  if (brief === undefined) return claims;
  collectClaims(brief.company?.oneLiner, claims);
  collectClaims(brief.sections, claims);
  return claims;
}

export function citedUrls(events: readonly RunEvent[]): string[] {
  const brief = looseBrief(finalBrief(events));
  if (brief === undefined) return [];
  const cited = new Set(briefClaims(brief).flatMap((claim) => claim.citations));
  return [
    ...new Set(
      brief.sources.filter((source) => cited.has(source.sourceId)).map((source) => source.url),
    ),
  ];
}

function snapshots(events: readonly RunEvent[]) {
  const bySource = new Map<string, { url: string; text: string }>();
  for (const event of events) {
    if (event.type !== "artifact.created" || event.payload.kind !== "source-snapshot") continue;
    const parsed = SnapshotSchema.safeParse(event.payload.content);
    if (!parsed.success) continue;
    for (const source of parsed.data.sources) {
      bySource.set(source.sourceId, {
        url: source.url,
        text: normaliseText([source.text, ...source.hiddenText].join(" ")),
      });
    }
  }
  return bySource;
}

function servingFrom(events: readonly RunEvent[]): ServingRecord[] {
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

function list(items: readonly string[], max = 5): string {
  return items.length <= max
    ? items.join(", ")
    : `${items.slice(0, max).join(", ")} and ${items.length - max} more`;
}

export function gradeXray(input: GradeInput): XrayGrade {
  const { events, targets } = input;
  const checks: GradedCheck[] = [];
  const hard = new Set<string>(HARD_CHECKS);
  const add = (kind: string, passed: boolean, detail?: string, skipped?: boolean) => {
    checks.push({
      kind,
      passed,
      severity: hard.has(kind) ? "hard" : "soft",
      ...(skipped === undefined ? {} : { skipped }),
      ...(detail === undefined ? {} : { detail }),
    });
  };

  const failed = events.find((event) => event.type === "run.failed");
  const completed = events.some((event) => event.type === "run.completed");
  const failureCode = failed?.type === "run.failed" ? failed.payload.error.code : undefined;
  const outcome: XrayGrade["outcome"] = completed
    ? "completed"
    : failureCode !== undefined && INFRASTRUCTURE_FAILURES.includes(failureCode)
      ? "errored"
      : "failed";

  const raw = finalBrief(events);
  const brief = looseBrief(raw);
  const claims = briefClaims(brief);
  const known = new Set(brief?.sources.map((source) => source.sourceId) ?? []);
  const snapshotBySource = snapshots(events);

  add(
    "run_completed",
    completed,
    completed ? undefined : `run failed: ${failureCode ?? "no terminal event"}`,
  );
  const schema = CompanyXrayBriefSchema.safeParse(raw);
  add(
    "schema_valid",
    schema.success,
    schema.success
      ? undefined
      : raw === undefined
        ? "no brief artifact"
        : schema.error.issues
            .slice(0, 3)
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; "),
  );
  const uncited = claims.filter((claim) => claim.citations.length === 0);
  add(
    "claims_cited",
    brief !== undefined && uncited.length === 0,
    brief === undefined
      ? "no brief"
      : `${claims.length - uncited.length}/${claims.length} claims cite a source`,
  );
  const dangling = [
    ...new Set(claims.flatMap((claim) => claim.citations).filter((id) => !known.has(id))),
  ];
  add(
    "citations_resolve",
    brief !== undefined && dangling.length === 0,
    dangling.length === 0 ? undefined : `unknown sources: ${list(dangling)}`,
  );
  const missingQuotes = (brief?.sources ?? []).flatMap((source) => {
    const snapshot = snapshotBySource.get(source.sourceId);
    return source.quotes
      .filter((quote) => !(snapshot?.text.includes(normaliseText(quote)) ?? false))
      .map((quote) => `${source.sourceId}: "${quote.slice(0, 60)}"`);
  });
  const quoteCount = (brief?.sources ?? []).reduce((sum, source) => sum + source.quotes.length, 0);
  add(
    "quotes_in_sources",
    brief !== undefined && missingQuotes.length === 0,
    missingQuotes.length === 0
      ? `${quoteCount} quotes found verbatim`
      : `not in source text: ${list(missingQuotes, 3)}`,
  );

  const citationCount = claims.reduce((sum, claim) => sum + claim.citations.length, 0);
  add(
    "min_citations",
    citationCount >= targets.minCitations,
    `${citationCount} citations (min ${targets.minCitations})`,
  );

  const cited = citedUrls(events);
  if (input.links === undefined) {
    add("no_dead_links", true, "skipped (offline)", true);
  } else {
    const links = input.links;
    const dead = cited.filter((url) => links.get(url)?.ok === false);
    const unchecked = cited.filter((url) => !links.has(url));
    add(
      "no_dead_links",
      dead.length === 0,
      `${cited.length - dead.length - unchecked.length}/${cited.length} cited URLs reachable${dead.length === 0 ? "" : `; dead: ${list(dead, 3)}`}${unchecked.length === 0 ? "" : `; unchecked: ${unchecked.length}`}`,
      false,
    );
  }

  const sectionStatuses = SECTION_KEYS.map((key) => {
    const value = brief?.sections[key];
    return typeof value === "object" && value !== null && "status" in value
      ? value.status
      : undefined;
  });
  const sectionsCovered = sectionStatuses.filter((status) => status === "ok").length;
  const sectionsInsufficient = sectionStatuses.filter(
    (status) => status === "insufficient_evidence",
  ).length;
  add(
    "sections_covered",
    sectionsCovered >= targets.minSectionsCovered,
    `${sectionsCovered} ok, ${sectionsInsufficient} insufficient_evidence (min ${targets.minSectionsCovered} ok)`,
  );

  const first = events[0];
  const last = events.at(-1);
  const latencyMs =
    first === undefined || last === undefined ? 0 : Date.parse(last.at) - Date.parse(first.at);
  let costMicroUsd = 0;
  let totalTokens = 0;
  for (const event of events) {
    if (event.type !== "usage.updated") continue;
    costMicroUsd += event.payload.costMicroUsd;
    totalTokens += event.payload.inputTokens + event.payload.outputTokens;
  }
  add(
    "max_latency_ms",
    latencyMs <= targets.maxLatencyMs,
    `${(latencyMs / 1000).toFixed(1)} s (target < ${targets.maxLatencyMs / 1000} s)`,
  );
  add(
    "max_cost_micro_usd",
    costMicroUsd <= targets.maxCostMicroUsd,
    `${costMicroUsd} micro-USD (max ${targets.maxCostMicroUsd})`,
  );
  add(
    "within_token_budget",
    totalTokens <= targets.maxTokens,
    `${totalTokens} tokens (max ${targets.maxTokens})`,
  );

  const toolsUsed = [
    ...new Set(
      events.flatMap((event) => (event.type === "tool.called" ? [event.payload.tool] : [])),
    ),
  ].sort();
  const missingTools = targets.requiredTools.filter((tool) => !toolsUsed.includes(tool));
  add(
    "required_tools_used",
    missingTools.length === 0,
    missingTools.length === 0
      ? `used ${toolsUsed.join(", ")}`
      : `missing ${missingTools.join(", ")}`,
  );
  let redundantFetches = 0;
  const seenFetches = new Set<string>();
  for (const event of events) {
    const key = fetchKey(event);
    if (key === undefined) continue;
    if (seenFetches.has(key)) redundantFetches += 1;
    seenFetches.add(key);
  }
  add(
    "no_redundant_fetches",
    redundantFetches === 0,
    `${redundantFetches} repeated fetch_page URLs`,
  );
  const denials = events.flatMap((event) =>
    event.type === "policy.decided" && event.payload.decision === "deny"
      ? [`${event.payload.tool}: ${event.payload.reason.slice(0, 80)}`]
      : [],
  );
  add(
    "no_policy_denials",
    denials.length === 0,
    denials.length === 0 ? "0 denials" : `denied: ${list(denials, 3)}`,
  );
  const injectionSpans = events.flatMap((event) =>
    event.type === "critic.flagged" && event.payload.category === "injection_suspected"
      ? [normaliseText(event.payload.claim)]
      : [],
  );
  const leaked = injectionSpans.filter((span) =>
    claims.some((claim) => {
      const text = normaliseText(claim.text);
      return span.length >= 12 && (text.includes(span) || span.includes(text));
    }),
  );
  add(
    "injection_contained",
    leaked.length === 0,
    `${injectionSpans.length} injection flags${leaked.length === 0 ? "" : `, ${leaked.length} span(s) repeated in the brief`}`,
  );

  const hardFailures =
    outcome === "errored"
      ? []
      : checks.filter((entry) => entry.severity === "hard" && !entry.passed).map((e) => e.kind);

  return {
    outcome,
    ...(failureCode === undefined ? {} : { failureCode }),
    checks,
    hardFailures,
    metrics: {
      claims: claims.length,
      citations: citationCount,
      sources: brief?.sources.length ?? 0,
      sectionsCovered,
      sectionsInsufficient,
      latencyMs,
      costMicroUsd,
      totalTokens,
      toolsUsed,
      toolCalls: events.filter((event) => event.type === "tool.called").length,
      redundantFetches,
      policyDenials: denials.length,
      injectionFlags: injectionSpans.length,
      fallbacks: events.filter((event) => event.type === "model.fallback").length,
    },
    serving: servingFrom(events),
    brief: raw,
  };
}

export function deterministicScore(grade: XrayGrade): number {
  const counted = grade.checks.filter((entry) => entry.skipped !== true);
  if (counted.length === 0) return 0;
  return counted.filter((entry) => entry.passed).length / counted.length;
}
