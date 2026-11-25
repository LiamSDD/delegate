import { defaultPolicy } from "@delegate/policy";
import {
  XRAY_PLAN,
  createMemoryPlaybookStore,
  deterministicLessons,
  entryId,
  parseRunEvent,
  plannerGuidance,
  recordRunLessons,
  reflectRun,
  selectGuidance,
  stepGuidance,
  type Playbook,
  type RunEvent,
  type RunEventDraft,
} from "@delegate/runtime";
import { loadPrompt } from "@delegate/runtime/server";
import { type z } from "zod";

import { compromisedModel, redteamRun, requestsFor, userText } from "./compromised-model";
import { type INJECTION_POINTS, type PlaybookPayloadSchema } from "./schema";

type Point = (typeof INJECTION_POINTS)[number];

export interface PlaybookVerdict {
  blockedBy: string;
  evidence: string[];
}

export class PlaybookHarnessError extends Error {
  override readonly name = "PlaybookHarnessError";
}

const KEY = "company-xray";
const SITE = "https://acme.example/";

function normalise(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/[\s_]+/g, " ")
    .trim()
    .toLowerCase();
}

function leaks(haystack: string, poison: readonly string[]): string[] {
  const text = normalise(haystack);
  return poison.filter((fragment) => text.includes(normalise(fragment)));
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

export function poisonedLog(injected: string, at: readonly Point[], failed: boolean): RunEvent[] {
  const pick = (point: Point, fallback: string) => (at.includes(point) ? injected : fallback);
  const runId = "run_poison";
  const stepId = at.includes("step.id") ? slug(injected) : "fill_gaps";
  const steps = XRAY_PLAN.map((step) =>
    step.id === "fill_gaps" ? { ...step, id: stepId } : step,
  ).map((step) => ({
    ...step,
    inputs: step.inputs.map((input) => (input === "fill_gaps" ? stepId : input)),
  }));
  const tool = pick("tool.name", "fetch_page");
  const sourceUrl = at.includes("source.url")
    ? `${SITE}${encodeURIComponent(injected)}?q=${encodeURIComponent(injected)}`
    : `${SITE}pricing`;
  const drafts: RunEventDraft[] = [
    {
      runId,
      type: "run.created",
      payload: {
        workspaceId: "ws_redteam",
        missionId: KEY,
        input: { url: SITE },
        actor: { type: "guest", id: "visitor" },
        budget: { maxTokens: 300_000, maxMicroUsd: 0 },
      },
    },
    {
      runId,
      type: "plan.proposed",
      payload: { version: 1, steps, source: "planner", rationale: pick("plan.rationale", "ok") },
    },
    {
      runId,
      type: "plan.approved",
      payload: { version: 1, approvedBy: { type: "system", id: "auto-approve" } },
    },
    { runId, type: "step.started", stepId: "research", payload: {} },
    {
      runId,
      type: "tool.called",
      stepId: "research",
      payload: {
        toolCallId: "t1",
        tool,
        capability: "web.fetch",
        argsSummary: pick("tool.args", "{}"),
      },
    },
    {
      runId,
      type: "artifact.created",
      stepId: "research",
      payload: {
        artifactId: "snap_1",
        kind: "source-snapshot",
        title: pick("artifact.title", "Sources"),
        version: 1,
        content: {
          sources: [
            {
              sourceId: "S1",
              url: sourceUrl,
              kind: pick("source.kind", "company_site"),
              text: pick("source.text", "Acme builds robots."),
            },
          ],
        },
      },
    },
    {
      runId,
      type: "tool.result",
      stepId: "research",
      payload: {
        toolCallId: "t1",
        tool,
        ok: false,
        summary: pick("tool.summary", "fetched"),
        error: pick("tool.error", "timeout"),
        durationMs: 400,
      },
    },
    {
      runId,
      type: "agent.message",
      stepId: "research",
      agentId: "researcher_1",
      payload: { text: pick("agent.message", "Fetched the site.") },
    },
    {
      runId,
      type: "model.fallback",
      stepId: "research",
      payload: {
        role: "worker",
        from: { provider: pick("fallback.provider", "pollinations"), model: "openai" },
        to: null,
        reason: "rate_limited",
      },
    },
    {
      runId,
      type: "step.completed",
      stepId: "research",
      payload: { outcome: "succeeded", summary: pick("step.summary", "done"), artifactIds: [] },
    },
    { runId, type: "step.started", stepId, payload: {} },
    {
      runId,
      type: "step.completed",
      stepId,
      payload: { outcome: "failed", summary: pick("step.summary", "failed"), artifactIds: [] },
    },
    {
      runId,
      type: "artifact.created",
      payload: {
        artifactId: "brief_1",
        kind: "company-xray-brief",
        title: pick("artifact.title", "Brief"),
        version: 1,
        content: { sources: [{ sourceId: "S1", url: sourceUrl, kind: "company_site" }] },
      },
    },
    {
      runId,
      type: "critic.flagged",
      payload: {
        claimId: "c1",
        claim: pick("critic.claim", "Acme is the leader."),
        reason: pick("critic.reason", "No source says so."),
        severity: "warn",
        category: "uncited",
      },
    },
    failed
      ? {
          runId,
          type: "run.failed",
          payload: {
            error: {
              code: pick("failure.code", "synthesis_invalid"),
              message: pick("failure.message", "invalid"),
            },
          },
        }
      : { runId, type: "run.completed", payload: { summary: pick("run.summary", "done") } },
  ];
  const start = Date.parse("2026-11-24T10:00:00.000Z");
  const events = drafts.map((draft, seq) =>
    parseRunEvent({ ...draft, seq, at: new Date(start + seq * 5_000).toISOString() }),
  );
  const raw = JSON.stringify(events);
  if (
    !raw.includes(injected) &&
    !raw.includes(encodeURIComponent(injected)) &&
    !raw.includes(slug(injected))
  )
    throw new PlaybookHarnessError("The injected text never reached the event log");
  return events;
}

function guidanceText(playbook: Playbook | null): string {
  const applied = selectGuidance([{ scope: "workspace", playbook }]);
  if (applied === null) return "";
  return [
    ...plannerGuidance(applied),
    ...applied.entries.flatMap((entry) =>
      entry.stepId === undefined
        ? []
        : stepGuidance(applied, { id: entry.stepId, capabilities: ["web.fetch"] }, "web.fetch"),
    ),
  ].join("\n");
}

async function viaReflect(
  payload: Extract<z.infer<typeof PlaybookPayloadSchema>, { via: "reflect" }>,
): Promise<PlaybookVerdict> {
  const events = poisonedLog(payload.injectedText, payload.at, payload.failed);
  const provider = compromisedModel({ reader: () => payload.reflectOutput ?? { keep: [] } });
  const { ctx } = redteamRun(provider, { policies: [defaultPolicy] });
  const run = { runId: "run_poison", frame: { missionId: KEY, input: { url: SITE } }, events };
  const lessons =
    payload.reflectOutput === undefined
      ? deterministicLessons(run, KEY)
      : await reflectRun(run, KEY, { ctx, prompt: loadPrompt("reflect.v1.md") });
  const store = createMemoryPlaybookStore();
  await store.record(lessons, { house: false });
  const { workspace } = await store.read(KEY);
  const evidence = [
    ...leaks(lessons.lessons.map((lesson) => lesson.text).join("\n"), payload.poison).map(
      (fragment) => `lesson text carries injected "${fragment}"`,
    ),
    ...leaks(guidanceText(workspace), payload.poison).map(
      (fragment) => `planner or sub-agent guidance carries injected "${fragment}"`,
    ),
  ];
  const reflectCalls = requestsFor(provider, "fast");
  if (payload.reflectOutput !== undefined && reflectCalls.length === 0)
    throw new PlaybookHarnessError("The compromised reflect model was never called");
  for (const request of reflectCalls)
    for (const fragment of leaks(userText(request), payload.poison))
      evidence.push(`the reflect model saw injected "${fragment}"`);
  return {
    blockedBy:
      payload.reflectOutput === undefined
        ? "lessons:structured-only"
        : "lessons:structured-only + reflect:choose-only",
    evidence,
  };
}

async function viaHouse(
  payload: Extract<z.infer<typeof PlaybookPayloadSchema>, { via: "house" }>,
): Promise<PlaybookVerdict> {
  const events = poisonedLog(payload.injectedText, ["critic.claim", "agent.message"], false);
  const lessons = deterministicLessons(
    { runId: "run_visitor", frame: { missionId: KEY, input: { url: SITE } }, events },
    KEY,
  );
  const store = createMemoryPlaybookStore();
  await recordRunLessons(store, lessons, {
    audience: payload.audience,
    ...(payload.houseLearning === undefined ? {} : { houseLearning: payload.houseLearning }),
  });
  const { house, workspace } = await store.read(KEY);
  if (workspace === null) throw new PlaybookHarnessError("The visitor's run was not recorded");
  return {
    blockedBy: "house:owner-only",
    evidence:
      house === null
        ? []
        : [`a ${payload.audience} run changed the house playbook to v${house.version}`],
  };
}

function viaRetrieval(
  payload: Extract<z.infer<typeof PlaybookPayloadSchema>, { via: "retrieval" }>,
): PlaybookVerdict {
  const at = "2026-11-24T10:00:00.000Z";
  const entries = payload.entries.map((entry) => ({
    id: entryId(entry.key),
    key: entry.key,
    kind: "plan_shape" as const,
    polarity: "keep" as const,
    text: entry.text,
    stepId: "research",
    evidence: 50,
    successSum: 50,
    firstSeenAt: at,
    lastSeenAt: at,
  }));
  const playbook: Playbook = {
    key: KEY,
    scope: "workspace",
    version: 3,
    runs: 50,
    runIds: [],
    entries,
    updatedAt: at,
  };
  const applied = selectGuidance([{ scope: "workspace", playbook }]);
  const dropped = entries.filter(
    (entry) => !(applied?.entries ?? []).some((used) => used.id === entry.id),
  );
  return {
    blockedBy: dropped.length > 0 ? "guidance:injection-filter" : "none",
    evidence: leaks(guidanceText(playbook), payload.poison).map(
      (fragment) => `a stored playbook entry put "${fragment}" into a prompt`,
    ),
  };
}

export function runPlaybook(
  payload: z.infer<typeof PlaybookPayloadSchema>,
): Promise<PlaybookVerdict> {
  switch (payload.via) {
    case "reflect":
      return viaReflect(payload);
    case "house":
      return viaHouse(payload);
    case "retrieval":
      return Promise.resolve(viaRetrieval(payload));
  }
}
