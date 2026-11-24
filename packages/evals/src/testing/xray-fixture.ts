import {
  XRAY_PLAN,
  type CompanyXrayBrief,
  type RunEvent,
  type RunEventDraft,
} from "@delegate/runtime";

import { createMemorySink } from "../event-log";

export const FIXTURE_RUN_ID = "run_fixture";
export const FIXTURE_START = Date.parse("2026-11-24T10:00:00.000Z");

export const FIXTURE_SNAPSHOTS = [
  {
    sourceId: "S1",
    url: "https://example.com/",
    title: "Example Corp",
    fetchedAt: "2026-11-24T10:00:01.000Z",
    kind: "company_site" as const,
    text: "Example Corp builds invoicing software for small accounting firms. Founded in 2009 in Lisbon, Example serves 4,000 firms across Europe. Example integrates with Stripe and QuickBooks.",
    hiddenText: [] as string[],
  },
  {
    sourceId: "S2",
    url: "https://en.wikipedia.org/wiki/Example_Corp",
    title: "Example Corp - Wikipedia",
    fetchedAt: "2026-11-24T10:00:02.000Z",
    kind: "wikipedia" as const,
    text: "Example Corp is a Portuguese software company headquartered in Lisbon. Its main competitor is Ledgerly.",
    hiddenText: [] as string[],
  },
];

const claim = (text: string, citations: string[]) => ({ text, citations });

export function fixtureBrief(): CompanyXrayBrief {
  const insufficient = { status: "insufficient_evidence" as const, note: "No evidence found." };
  return {
    missionId: "company-xray",
    status: "complete",
    company: {
      name: "Example Corp",
      url: "https://example.com/",
      oneLiner: claim("Invoicing software for small accounting firms.", ["S1"]),
    },
    sources: FIXTURE_SNAPSHOTS.map(({ text: _text, hiddenText: _hidden, ...record }) => ({
      ...record,
      quotes:
        record.sourceId === "S1"
          ? ["Founded in 2009 in Lisbon", "Example serves 4,000 firms across Europe"]
          : ["headquartered in Lisbon"],
    })),
    sourceMix: { company_site: 1, wikipedia: 1, wikidata: 0, github: 0, feed: 0 },
    generatedAt: "2026-11-24T10:01:00.000Z",
    promptVersions: [
      "quarantine-reader@1",
      "company-xray.researcher@1",
      "company-xray.synthesis@1",
    ],
    sections: {
      offering: { status: "ok", claims: [claim("Invoicing software for accountants.", ["S1"])] },
      customers: { status: "ok", claims: [claim("Serves 4,000 firms in Europe.", ["S1"])] },
      market: { status: "ok", claims: [claim("Portuguese software company.", ["S2"])] },
      competitors: {
        status: "ok",
        competitors: [{ name: "Ledgerly", claim: claim("Named main competitor.", ["S2"]) }],
      },
      positioning: insufficient,
      news: insufficient,
      swot: {
        status: "ok",
        strengths: [claim("Established since 2009.", ["S1", "S2"])],
        weaknesses: [],
        opportunities: [],
        threats: [],
      },
      techStack: {
        status: "ok",
        claims: [claim("Integrates with Stripe and QuickBooks.", ["S1"])],
      },
    },
  };
}

export interface FixtureOptions {
  brief?: unknown;
  durationMs?: number;
  costMicroUsd?: number;
  tokens?: number;
  extra?: RunEventDraft[];
  failure?: { code: string; message: string };
  fetches?: string[];
}

export async function xrayFixtureEvents(options: FixtureOptions = {}): Promise<RunEvent[]> {
  const durationMs = options.durationMs ?? 60_000;
  const drafts: RunEventDraft[] = [];
  const add = (draft: RunEventDraft) => drafts.push(draft);
  const runId = FIXTURE_RUN_ID;
  const usage = (stepId: string, model: string) =>
    add({
      runId,
      type: "usage.updated",
      stepId,
      payload: {
        inputTokens: Math.round((options.tokens ?? 6_000) * 0.4),
        outputTokens: Math.round((options.tokens ?? 6_000) * 0.1),
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costMicroUsd: Math.round((options.costMicroUsd ?? 0) / 2),
        provider: "pollinations",
        model,
      },
    });
  add({
    runId,
    type: "run.created",
    payload: {
      workspaceId: "eval",
      missionId: "company-xray",
      input: { url: "https://example.com/" },
      actor: { type: "system", id: "eval" },
      budget: { maxTokens: 300_000, maxMicroUsd: 0 },
    },
  });
  add({ runId, type: "plan.proposed", payload: { version: 1, steps: [...XRAY_PLAN] } });
  add({
    runId,
    type: "plan.approved",
    payload: { version: 1, approvedBy: { type: "system", id: "m1-auto-approve" } },
  });
  add({ runId, type: "step.started", stepId: "research", payload: {} });
  add({
    runId,
    type: "policy.decided",
    stepId: "research",
    payload: {
      toolCallId: "tc_1",
      tool: "crawl_site",
      decision: "allow",
      policyId: "default",
      reason: "ok",
    },
  });
  add({
    runId,
    type: "tool.called",
    stepId: "research",
    payload: { toolCallId: "tc_1", tool: "crawl_site", capability: "web.fetch", argsSummary: "{}" },
  });
  add({
    runId,
    type: "artifact.created",
    stepId: "research",
    payload: {
      artifactId: "snap_1",
      kind: "source-snapshot",
      title: "Sources",
      version: 1,
      content: { sources: FIXTURE_SNAPSHOTS },
    },
  });
  add({
    runId,
    type: "tool.result",
    stepId: "research",
    payload: {
      toolCallId: "tc_1",
      tool: "crawl_site",
      ok: true,
      summary: "2 pages",
      durationMs: 900,
      artifactId: "snap_1",
    },
  });
  for (const [index, url] of (options.fetches ?? []).entries()) {
    const toolCallId = `tc_f${index + 1}`;
    add({
      runId,
      type: "tool.called",
      stepId: "research",
      payload: {
        toolCallId,
        tool: "fetch_page",
        capability: "web.fetch",
        argsSummary: JSON.stringify({ url }),
      },
    });
  }
  add({
    runId,
    type: "step.completed",
    stepId: "research",
    payload: { outcome: "succeeded", summary: "2 sources", artifactIds: ["snap_1"] },
  });
  add({ runId, type: "step.started", stepId: "read", payload: {} });
  add({
    runId,
    type: "agent.spawned",
    stepId: "read",
    agentId: "reader_1",
    payload: { role: "analyst", modelRole: "fast" },
  });
  usage("read", "openai");
  for (const draft of options.extra ?? []) add(draft);
  if (options.failure !== undefined) {
    add({
      runId,
      type: "step.completed",
      stepId: "read",
      payload: { outcome: "failed", summary: options.failure.message, artifactIds: [] },
    });
    add({ runId, type: "run.failed", payload: { error: options.failure } });
  } else {
    add({
      runId,
      type: "step.completed",
      stepId: "read",
      payload: { outcome: "succeeded", summary: "facts", artifactIds: [] },
    });
    add({ runId, type: "step.started", stepId: "synthesise", payload: {} });
    add({
      runId,
      type: "agent.spawned",
      stepId: "synthesise",
      agentId: "editor_1",
      payload: { role: "editor", modelRole: "planner" },
    });
    usage("synthesise", "openai");
    add({
      runId,
      type: "artifact.created",
      stepId: "synthesise",
      payload: {
        artifactId: "brief_1",
        kind: "company-xray-brief",
        title: "Company X-ray: Example Corp",
        version: 1,
        content: { status: "draft" },
      },
    });
    add({
      runId,
      type: "artifact.updated",
      stepId: "synthesise",
      payload: { artifactId: "brief_1", version: 2, content: options.brief ?? fixtureBrief() },
    });
    add({
      runId,
      type: "step.completed",
      stepId: "synthesise",
      payload: { outcome: "succeeded", summary: "brief", artifactIds: ["brief_1"] },
    });
    add({ runId, type: "run.completed", payload: { summary: "Company X-ray for Example Corp" } });
  }
  let index = 0;
  const step = durationMs / Math.max(1, drafts.length - 1);
  const sink = createMemorySink(() => new Date(FIXTURE_START + Math.round(step * index++)));
  for (const draft of drafts) await sink.emit(draft);
  return sink.events;
}
