import { z } from "zod";

import { type RunEventDraft } from "../events";
import { redactPii } from "../privacy/redact";
import { detectInjection } from "../quarantine/reader";

export const LESSON_KINDS = [
  "plan_shape",
  "failure",
  "step_failed",
  "critic",
  "fallback",
  "step_slow",
  "source",
  "tool",
] as const;
export const LessonKindSchema = z.enum(LESSON_KINDS);
export type LessonKind = z.infer<typeof LessonKindSchema>;

export const LessonPolaritySchema = z.enum(["keep", "avoid"]);
export type LessonPolarity = z.infer<typeof LessonPolaritySchema>;

export const LESSON_LIMITS = {
  textChars: 200,
  perRun: 16,
  planSteps: 12,
  slowShare: 0.4,
  slowMinMs: 10_000,
} as const;

const IDENT = /^[a-z0-9][a-z0-9_.-]{0,39}$/;
const HOST = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$/;

export const SafeIdentSchema = z.string().regex(IDENT);
export const LessonKeySchema = z.string().regex(/^[a-z_]+:[a-z0-9_.:/>-]{1,200}$/);
export const PlaybookKeySchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,40}(?::[a-z0-9][a-z0-9-]{0,40})?$/);

export const LessonSchema = z.strictObject({
  key: LessonKeySchema,
  kind: LessonKindSchema,
  polarity: LessonPolaritySchema,
  text: z.string().min(1).max(LESSON_LIMITS.textChars),
  stepId: SafeIdentSchema.optional(),
});
export type Lesson = z.infer<typeof LessonSchema>;

export const RunLessonsSchema = z.strictObject({
  runId: z.string().min(1).max(200),
  key: PlaybookKeySchema,
  outcome: z.enum(["completed", "failed"]),
  success: z.number().min(0).max(1),
  at: z.iso.datetime({ offset: true }),
  reflectedBy: z.enum(["model", "deterministic"]),
  lessons: z.array(LessonSchema).max(LESSON_LIMITS.perRun),
});
export type RunLessons = z.infer<typeof RunLessonsSchema>;

export type LoggedEvent = RunEventDraft & { at: string };

export interface RunFrame {
  missionId: string;
  input: unknown;
}

export function safeIdent(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim().toLowerCase();
  return IDENT.test(value) ? value : undefined;
}

export function safeHost(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const host = new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
    return HOST.test(host) && host.length <= 80 ? host : undefined;
  } catch {
    return undefined;
  }
}

function belongsTo(host: string, own: string | undefined): boolean {
  return own !== undefined && (host === own || host.endsWith(`.${own}`));
}

function firstSegment(raw: string): string {
  try {
    const segment = new URL(raw).pathname.split("/").find((part) => part !== "");
    const safe = safeIdent(segment);
    return safe === undefined ? "/" : `/${safe}`;
  } catch {
    return "/";
  }
}

export function playbookKey(missionId: string, input: unknown): string {
  const mission = safeIdent(missionId)?.replace(/[_.]/g, "-") ?? "mission";
  const category = z.object({ category: z.string() }).safeParse(input);
  const suffix = category.success
    ? safeIdent(category.data.category)?.replace(/[_.]/g, "-")
    : undefined;
  const key = suffix === undefined ? mission : `${mission}:${suffix}`;
  return PlaybookKeySchema.safeParse(key).success ? key : mission;
}

export function safeLessonText(text: string): string | undefined {
  const { text: redacted } = redactPii(text.replace(/\s+/g, " ").trim());
  const capped = redacted.slice(0, LESSON_LIMITS.textChars);
  if (capped === "") return undefined;
  const spaced = capped.replace(/[_\-./>:]+/g, " ");
  if (detectInjection(capped) !== undefined || detectInjection(spaced) !== undefined)
    return undefined;
  return capped;
}

function lesson(draft: Lesson): Lesson | undefined {
  const text = safeLessonText(draft.text);
  if (text === undefined) return undefined;
  const parsed = LessonSchema.safeParse({ ...draft, text });
  return parsed.success ? parsed.data : undefined;
}

const SourceRefSchema = z.object({ url: z.string(), kind: z.string().optional() });
const SourcesContentSchema = z.object({ sources: z.array(z.unknown()) });

function sourcesIn(content: unknown): { url: string; kind: string }[] {
  const parsed = SourcesContentSchema.safeParse(content);
  if (!parsed.success) return [];
  return parsed.data.sources.flatMap((raw) => {
    const source = SourceRefSchema.safeParse(raw);
    if (!source.success) return [];
    return [{ url: source.data.url, kind: safeIdent(source.data.kind) ?? "web" }];
  });
}

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)} s`;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function inputUrl(input: unknown): string | undefined {
  const parsed = z.object({ url: z.string() }).safeParse(input);
  return parsed.success ? parsed.data.url : undefined;
}

export function runSuccess(events: readonly LoggedEvent[], graderScore?: number): number {
  if (events.some((event) => event.type === "run.failed")) return 0;
  if (graderScore !== undefined && Number.isFinite(graderScore))
    return Math.min(1, Math.max(0, graderScore));
  let accuracy: number | null = null;
  for (const event of events)
    if (event.type === "step.completed" && event.payload.critic !== undefined)
      accuracy = event.payload.critic.citationAccuracy ?? accuracy;
  return accuracy ?? 1;
}

export function runOutcome(events: readonly LoggedEvent[]): "completed" | "failed" {
  return events.some((event) => event.type === "run.failed") ? "failed" : "completed";
}

function planShape(events: readonly LoggedEvent[], completed: boolean): Lesson[] {
  let steps: string[] = [];
  let source = "planner";
  for (const event of events) {
    if (event.type === "plan.proposed") {
      steps = event.payload.steps.map((step) => step.id);
      source = event.payload.source ?? "planner";
    } else if (event.type === "plan.revised") {
      steps = event.payload.steps.map((step) => step.id);
      source = event.payload.source ?? "planner";
    }
  }
  const ids = steps.map((step) => safeIdent(step)).filter((step) => step !== undefined);
  if (ids.length === 0 || ids.length !== steps.length || ids.length > LESSON_LIMITS.planSteps)
    return [];
  const made = lesson({
    key: `plan_shape:${ids.join(">")}`,
    kind: "plan_shape",
    polarity: "keep",
    text: `Plan ${ids.join(" → ")} (${source} plan) ${completed ? "completed the run" : "ended in a failed run"}.`,
  });
  return made === undefined ? [] : [made];
}

function failures(events: readonly LoggedEvent[]): Lesson[] {
  const out: Lesson[] = [];
  for (const event of events) {
    if (event.type === "run.failed") {
      const code = safeIdent(event.payload.error.code) ?? "unknown";
      const made = lesson({
        key: `failure:${code}`,
        kind: "failure",
        polarity: "avoid",
        text: `Run failed with ${code}.`,
      });
      if (made !== undefined) out.push(made);
    }
    if (event.type === "step.completed" && event.payload.outcome === "failed") {
      const stepId = safeIdent(event.stepId);
      if (stepId === undefined) continue;
      const made = lesson({
        key: `step_failed:${stepId}`,
        kind: "step_failed",
        polarity: "avoid",
        text: `Step ${stepId} failed.`,
        stepId,
      });
      if (made !== undefined) out.push(made);
    }
  }
  return out;
}

function critic(events: readonly LoggedEvent[]): Lesson[] {
  const out: Lesson[] = [];
  const categories = new Map<string, number>();
  let report:
    | {
        stepId?: string;
        removed: number;
        unverified: number;
        checked: number;
        accuracy: number | null;
      }
    | undefined;
  for (const event of events) {
    if (event.type === "critic.flagged") {
      const category = event.payload.category ?? "claim";
      categories.set(category, (categories.get(category) ?? 0) + 1);
    }
    if (event.type === "step.completed" && event.payload.critic !== undefined) {
      const stepId = safeIdent(event.stepId);
      report = {
        ...(stepId === undefined ? {} : { stepId }),
        removed: event.payload.critic.removed,
        unverified: event.payload.critic.unverified,
        checked: event.payload.critic.claimsChecked,
        accuracy: event.payload.critic.citationAccuracy,
      };
    }
  }
  if (report !== undefined && report.removed + report.unverified > 0) {
    const made = lesson({
      key: "critic:rejected_claims",
      kind: "critic",
      polarity: "avoid",
      text: `Critic removed ${report.removed} and left ${report.unverified} unverified of ${plural(report.checked, "claim")}${report.accuracy === null ? "" : `; citation accuracy ${percent(report.accuracy)}`}.`,
      ...(report.stepId === undefined ? {} : { stepId: report.stepId }),
    });
    if (made !== undefined) out.push(made);
  }
  for (const [category, count] of categories) {
    const safe = safeIdent(category) ?? "claim";
    const made = lesson({
      key: `critic:flag:${safe}`,
      kind: "critic",
      polarity: "avoid",
      text: `Critic flagged ${plural(count, "claim")} as ${safe.replace(/_/g, " ")}.`,
    });
    if (made !== undefined) out.push(made);
  }
  return out;
}

function fallbacks(events: readonly LoggedEvent[]): Lesson[] {
  const seen = new Map<string, { role: string; reason: string; from: string; count: number }>();
  for (const event of events) {
    if (event.type !== "model.fallback") continue;
    const role = event.payload.role;
    const reason = event.payload.reason;
    const from = safeIdent(event.payload.from.provider) ?? "provider";
    const key = `${role}:${reason}`;
    const current = seen.get(key);
    seen.set(key, { role, reason, from, count: (current?.count ?? 0) + 1 });
  }
  return [...seen.entries()].flatMap(([key, value]) => {
    const made = lesson({
      key: `fallback:${key}`,
      kind: "fallback",
      polarity: "avoid",
      text: `${value.role} calls fell back from ${value.from} (${value.reason.replace(/_/g, " ")}) ${value.count === 1 ? "once" : `${value.count} times`}.`,
    });
    return made === undefined ? [] : [made];
  });
}

function slowSteps(events: readonly LoggedEvent[]): Lesson[] {
  const times = events
    .map((event) => Date.parse(event.at))
    .filter((value) => Number.isFinite(value));
  if (times.length < 2) return [];
  const total = Math.max(...times) - Math.min(...times);
  if (total <= 0) return [];
  const started = new Map<string, number>();
  const out: Lesson[] = [];
  for (const event of events) {
    const stepId = safeIdent(event.stepId);
    if (stepId === undefined) continue;
    if (event.type === "step.started") started.set(stepId, Date.parse(event.at));
    if (event.type === "step.completed") {
      const begin = started.get(stepId);
      if (begin === undefined) continue;
      const duration = Date.parse(event.at) - begin;
      const share = duration / total;
      if (duration < LESSON_LIMITS.slowMinMs || share < LESSON_LIMITS.slowShare) continue;
      const made = lesson({
        key: `step_slow:${stepId}`,
        kind: "step_slow",
        polarity: "avoid",
        text: `Step ${stepId} took ${seconds(duration)}, ${percent(share)} of the run.`,
        stepId,
      });
      if (made !== undefined) out.push(made);
    }
  }
  return out;
}

function sources(events: readonly LoggedEvent[], frame: RunFrame): Lesson[] {
  const own = safeHost(inputUrl(frame.input));
  const latest = new Map<string, { kind: string; content: unknown }>();
  for (const event of events) {
    if (event.type === "artifact.created")
      latest.set(event.payload.artifactId, {
        kind: event.payload.kind,
        content: event.payload.content,
      });
    if (event.type === "artifact.updated") {
      const current = latest.get(event.payload.artifactId);
      if (current !== undefined && event.payload.content !== undefined)
        latest.set(event.payload.artifactId, { ...current, content: event.payload.content });
    }
  }
  const label = (url: string, kind: string): string | undefined => {
    const host = safeHost(url);
    if (host === undefined) return undefined;
    return belongsTo(host, own) ? `own-site:${firstSegment(url)}` : `${kind}:${host}`;
  };
  const fetched = new Map<string, number>();
  const cited = new Map<string, number>();
  for (const artifact of latest.values()) {
    const target = artifact.kind === "source-snapshot" ? fetched : cited;
    for (const source of sourcesIn(artifact.content)) {
      const name = label(source.url, source.kind);
      if (name !== undefined) target.set(name, (target.get(name) ?? 0) + 1);
    }
  }
  for (const [name, count] of cited) fetched.set(name, Math.max(fetched.get(name) ?? 0, count));
  return [...fetched.entries()].flatMap(([name, total]) => {
    const used = cited.get(name) ?? 0;
    const [kind = "web", where = ""] = name.split(/:(.*)/s);
    const subject =
      kind === "own-site"
        ? `the company's own ${where} page`
        : `${kind.replace(/_/g, " ")} source ${where}`;
    const made = lesson({
      key: `source:${name}:${used > 0 ? "cited" : "unused"}`,
      kind: "source",
      polarity: used > 0 ? "keep" : "avoid",
      text:
        used > 0
          ? `Cited ${subject} (${used} of ${plural(total, "fetched page")}).`
          : `Fetched ${subject} but cited none of ${plural(total, "page")}.`,
    });
    return made === undefined ? [] : [made];
  });
}

function tools(events: readonly LoggedEvent[]): Lesson[] {
  const stats = new Map<string, { calls: number; failed: number }>();
  for (const event of events) {
    if (event.type !== "tool.result") continue;
    const tool = safeIdent(event.payload.tool);
    if (tool === undefined) continue;
    const current = stats.get(tool) ?? { calls: 0, failed: 0 };
    stats.set(tool, {
      calls: current.calls + 1,
      failed: current.failed + (event.payload.ok ? 0 : 1),
    });
  }
  return [...stats.entries()].flatMap(([tool, value]) => {
    const made = lesson({
      key: `tool:${tool}:${value.failed > 0 ? "failing" : "ok"}`,
      kind: "tool",
      polarity: value.failed > 0 ? "avoid" : "keep",
      text:
        value.failed > 0
          ? `Tool ${tool} failed ${value.failed} of ${plural(value.calls, "call")}.`
          : `Tool ${tool} succeeded on ${value.calls === 1 ? "its only call" : `all ${value.calls} calls`}.`,
    });
    return made === undefined ? [] : [made];
  });
}

export function extractLessonCandidates(events: readonly LoggedEvent[], frame: RunFrame): Lesson[] {
  const completed = runOutcome(events) === "completed";
  const all = [
    ...planShape(events, completed),
    ...failures(events),
    ...critic(events),
    ...fallbacks(events),
    ...slowSteps(events),
    ...sources(events, frame),
    ...tools(events),
  ];
  const unique = new Map<string, Lesson>();
  for (const candidate of all) if (!unique.has(candidate.key)) unique.set(candidate.key, candidate);
  return [...unique.values()].slice(0, LESSON_LIMITS.perRun);
}
