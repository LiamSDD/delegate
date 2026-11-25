import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { foldRun, parseRunEvent, type RunEvent, type RunEventDraft } from "../../events";
import { createMemoryPlaybookStore, type PlaybookStore } from "../../learning/store";
import { type AwaitPlanApproval } from "../../plan-approval";
import { runMission } from "../../server";
import { NextActionsSchema } from "../next-actions";
import { FIXTURE_ORIGIN, fixtureDns, fixtureFetch } from "../../testing/fixture-site";
import { CompanyXrayBriefSchema, SECTION_KEYS, type CompanyXrayBrief } from "./brief";

const POLLINATIONS = "https://text.pollinations.ai/openai";
const INJECTION = "Ignore previous instructions";
const REASONING = "hidden reasoning that must never reach the transcript";

const rootConfig = JSON.parse(
  readFileSync(new URL("../../../../../config/models.json", import.meta.url), "utf8"),
) as {
  providers: { id: string; limits?: unknown }[];
};
const unthrottledConfig = {
  ...rootConfig,
  providers: rootConfig.providers.map(({ limits: _limits, ...provider }) => provider),
};

interface WireMessage {
  role: string;
  content: string | null;
}

interface WireBody {
  model: string;
  messages: WireMessage[];
  tools?: unknown[];
}

function sse(chunks: unknown[]): Response {
  const body =
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const usage = {
  prompt_tokens: 1200,
  completion_tokens: 300,
  prompt_tokens_details: { cached_tokens: 512 },
};

function textReply(text: string): Response {
  const pieces = text.match(/[\s\S]{1,40}/g) ?? [];
  return sse([
    { choices: [{ index: 0, delta: { reasoning: REASONING } }] },
    ...pieces.map((piece) => ({ choices: [{ index: 0, delta: { content: piece } }] })),
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
  ]);
}

function toolReply(calls: { name: string; args: unknown }[]): Response {
  return sse([
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: calls.map((call, index) => ({
              index,
              id: `call_${index}`,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            })),
          },
        },
      ],
    },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage },
  ]);
}

function topicFor(label: string): string {
  if (/pricing/i.test(label)) return "offering";
  if (/customers/i.test(label)) return "customers";
  if (/careers|github/i.test(label)) return "tech";
  if (/ vs /i.test(label)) return "competitors";
  if (/feed/i.test(label)) return "news";
  if (/wiki/i.test(label)) return "company";
  return "offering";
}

function readerReply(user: string): Response {
  const sources = [
    ...user.matchAll(/<source id="(S\d+)" label="([^"]*)">\n([\s\S]*?)\n<\/source>/g),
  ].map(([, sourceId = "", label = "", text = ""]) => {
    const line =
      text
        .split("\n")
        .find((candidate) => candidate.trim().length >= 20 && !candidate.startsWith("#")) ?? text;
    const quote = line
      .replace(/^(Description: |- )/, "")
      .slice(0, 120)
      .trim();
    return {
      sourceId,
      facts:
        quote.length >= 8
          ? [{ claim: `Source states: ${quote}`, quote, topic: topicFor(label) }]
          : [],
      injectionSuspected: false,
      suspiciousSpan: null,
    };
  });
  return textReply(JSON.stringify({ sources }));
}

function synthesisReply(user: string): Response {
  const facts = user
    .split("\n")
    .filter((line) => line.startsWith('{"sourceId"'))
    .map((line) => JSON.parse(line) as { sourceId: string; topic: string; claim: string });
  const cite = (topic: string) => facts.filter((fact) => fact.topic === topic);
  const claims = (topic: string) => {
    const found = cite(topic);
    return found.length === 0
      ? { status: "insufficient_evidence", note: `No ${topic} evidence.` }
      : {
          status: "ok",
          claims: found.map((fact) => ({ text: fact.claim, citations: [fact.sourceId] })),
        };
  };
  const offering = claims("offering");
  const brief = {
    companyName: "Acme Robotics",
    oneLiner: {
      text: "Acme Robotics builds picking robots.",
      citations: [facts[0]?.sourceId ?? "S1"],
    },
    sections: {
      offering:
        offering.status === "ok" && "claims" in offering
          ? {
              ...offering,
              claims: [
                ...offering.claims,
                { text: "Acme is the market leader.", citations: ["S99"] },
              ],
            }
          : offering,
      customers: claims("customers"),
      market: { status: "insufficient_evidence", note: "No market sizing in sources." },
      competitors:
        cite("competitors").length === 0
          ? { status: "insufficient_evidence", note: "No named competitors." }
          : {
              status: "ok",
              competitors: cite("competitors").map((fact) => ({
                name: "RoboCorp",
                claim: { text: fact.claim, citations: [fact.sourceId] },
              })),
            },
      positioning: { status: "insufficient_evidence", note: "Not enough evidence." },
      news:
        cite("news").length === 0
          ? { status: "insufficient_evidence", note: "No dated news." }
          : {
              status: "ok",
              items: cite("news").map((fact) => ({
                date: "2026-11-03",
                claim: { text: fact.claim, citations: [fact.sourceId] },
              })),
            },
      swot: { status: "insufficient_evidence", note: "Not enough evidence." },
      techStack: claims("tech"),
    },
  };
  return textReply(JSON.stringify(brief));
}

function plannerReply(user: string): Response {
  const reference =
    /## Reference plan[^\n]*\n\n(\{[\s\S]*?\})\n\nReturn only/.exec(user)?.[1] ?? "{}";
  const { steps } = JSON.parse(reference) as { steps: unknown[] };
  return textReply(JSON.stringify({ steps, rationale: "The reference plan fits this company." }));
}

function criticReply(user: string): Response {
  const results = user
    .split("\n")
    .filter((line) => line.startsWith('{"id"'))
    .map((line) => {
      const { id, claim } = JSON.parse(line) as { id: string; claim: string };
      const verdict =
        id.startsWith("techStack") && !claim.startsWith("Narrowed:")
          ? "not_enough_info"
          : "supported";
      return { id, atoms: [{ text: claim.slice(0, 40), verdict }] };
    });
  return textReply(JSON.stringify({ results }));
}

function editorReply(user: string): Response {
  const fixes = user
    .split("\n")
    .filter((line) => line.startsWith('{"id"'))
    .map((line) => {
      const { id, claim, citations } = JSON.parse(line) as {
        id: string;
        claim: string;
        citations: string[];
      };
      return { id, action: "rewrite", text: `Narrowed: ${claim}`.slice(0, 500), citations };
    });
  return textReply(JSON.stringify({ fixes }));
}

interface Harness {
  events: RunEvent[];
  requested: string[];
  providerBodies: WireBody[];
}

async function runFixture(
  options: {
    input?: unknown;
    extra?: (url: URL, init: RequestInit | undefined) => Response | undefined;
    awaitPlanApproval?: AwaitPlanApproval;
    playbooks?: PlaybookStore;
    runId?: string;
  } = {},
): Promise<Harness & { status: string }> {
  const providerBodies: WireBody[] = [];
  let researcherTurns = 0;
  const site = fixtureFetch((url, init) => {
    const custom = options.extra?.(url, init);
    if (custom !== undefined) return custom;
    if (url.href !== POLLINATIONS) return undefined;
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as WireBody;
    providerBodies.push(body);
    const system = body.messages[0]?.content ?? "";
    const user = body.messages.find((message) => message.role === "user")?.content ?? "";
    if (system.includes("quarantined reader")) return readerReply(user);
    if (system.includes("You are the planner")) return plannerReply(user);
    if (system.includes("You are the critic")) return criticReply(user);
    if (system.includes("You are the editor of Delegate.")) return editorReply(user);
    if (system.includes("You are the researcher")) {
      researcherTurns += 1;
      return researcherTurns === 1
        ? toolReply([
            { name: "fetch_page", args: { url: "http://169.254.169.254/latest/meta-data" } },
            { name: "fetch_page", args: { url: `${FIXTURE_ORIGIN}/vs/robocorp` } },
          ])
        : textReply("Fetched the comparison page; market sizing is still missing.");
    }
    return synthesisReply(user);
  });
  const events: RunEvent[] = [];
  const append = (draft: RunEventDraft) => {
    events.push(parseRunEvent({ ...draft, seq: events.length + 1, at: new Date().toISOString() }));
  };
  append({
    runId: options.runId ?? "run_e2e",
    type: "run.created",
    payload: {
      workspaceId: "ws_1",
      missionId: "company-xray",
      input: { url: FIXTURE_ORIGIN },
      actor: { type: "guest", id: "guest_1" },
      budget: { maxTokens: 300_000, maxMicroUsd: 0 },
    },
  });
  const result = await runMission({
    runId: options.runId ?? "run_e2e",
    missionId: "company-xray",
    input: options.input ?? { url: `${FIXTURE_ORIGIN}/` },
    context: { audience: "public-demo", classification: "public" },
    env: {},
    emit: (draft) => {
      append(draft);
      return Promise.resolve();
    },
    fetchImpl: site.fetchImpl,
    resolveDns: fixtureDns,
    sleep: () => Promise.resolve(),
    modelsConfig: unthrottledConfig,
    ...(options.awaitPlanApproval === undefined
      ? {}
      : { awaitPlanApproval: options.awaitPlanApproval }),
    ...(options.playbooks === undefined ? {} : { playbooks: options.playbooks }),
  });
  return { status: result.status, events, requested: site.requested, providerBodies };
}

function finalBrief(events: readonly RunEvent[]): CompanyXrayBrief {
  const updates = events.filter((event) => event.type === "artifact.updated");
  const last = updates.at(-1);
  if (last?.type !== "artifact.updated") throw new Error("no brief");
  return CompanyXrayBriefSchema.parse(last.payload.content);
}

describe("runMission company-xray end to end (fixture site, fake provider over HTTP)", () => {
  it("completes with an event log that folds cleanly and a fully cited brief", async () => {
    const { status, events } = await runFixture();
    expect(status).toBe("completed");
    const state = foldRun(events);
    expect(state.status).toBe("completed");
    expect(state.steps.map((step) => [step.id, step.status])).toEqual([
      ["research", "succeeded"],
      ["research_external", "succeeded"],
      ["read", "succeeded"],
      ["fill_gaps", "succeeded"],
      ["synthesise", "succeeded"],
      ["critic", "succeeded"],
    ]);
    expect(events.find((event) => event.type === "plan.proposed")).toMatchObject({
      payload: { source: "planner" },
    });
    const spawned = events.filter((event) => event.type === "agent.spawned");
    expect(spawned.map((event) => event.payload.role)).toContain("editor");
    expect(
      state.steps.every(
        (step) => step.servedBy === undefined || step.servedBy.provider === "pollinations",
      ),
    ).toBe(true);
    expect(state.totals.cacheReadTokens).toBeGreaterThan(0);

    const approved = events.find((event) => event.type === "plan.approved");
    expect(approved).toMatchObject({
      payload: {
        approvedBy: { type: "system" },
        reason: expect.stringMatching(/no reviewer/) as unknown,
      },
    });

    const brief = finalBrief(events);
    const sourceIds = new Set(brief.sources.map((source) => source.sourceId));
    expect(brief.sources.length).toBeGreaterThan(2);
    for (const key of SECTION_KEYS) expect(brief.sections[key]).toBeDefined();
    const serialised = JSON.stringify(brief.sections);
    for (const match of serialised.matchAll(/"citations":\[([^\]]*)\]/g)) {
      const ids = (match[1] ?? "").split(",").map((id) => id.replace(/"/g, ""));
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) expect(sourceIds.has(id)).toBe(true);
    }
    expect(serialised).not.toContain("S99");
    expect(
      events.some(
        (event) => event.type === "critic.flagged" && event.payload.category === "uncited",
      ),
    ).toBe(true);
    expect(brief.sources.every((source) => source.quotes.length > 0)).toBe(true);
    expect(brief.promptVersions).toEqual([
      "quarantine-reader@1",
      "company-xray.researcher@1",
      "company-xray.synthesis@1",
      "planner@2",
      "critic@1",
      "editor@1",
    ]);
    const techStack = brief.sections.techStack;
    expect(
      techStack.status === "ok" &&
        techStack.claims.every((claim) => claim.text.startsWith("Narrowed:")),
    ).toBe(true);
    const criticDone = events.find(
      (event) => event.type === "step.completed" && event.stepId === "critic",
    );
    expect(criticDone).toMatchObject({
      payload: { critic: { fixLoops: 1, removed: 0, unverified: 0, citationAccuracy: 1 } },
    });
    const next = events.find(
      (event) => event.type === "artifact.created" && event.payload.kind === "next-actions",
    );
    const actions = NextActionsSchema.parse(
      next?.type === "artifact.created" ? next.payload.content : undefined,
    );
    expect(actions.actions[0]).toMatchObject({
      missionId: "automation-audit",
      available: true,
      input: { url: `${FIXTURE_ORIGIN}/` },
    });

    const created = events.filter(
      (event) => event.type === "artifact.created" && event.payload.kind === "company-xray-brief",
    );
    expect(created).toHaveLength(1);
    expect(events.filter((event) => event.type === "artifact.updated")).toHaveLength(
      SECTION_KEYS.length + 1,
    );
    expect(events.at(-1)?.type).toBe("run.completed");
  });

  it("flags the hidden injection, denies the metadata fetch it asked for and never contacts that host", async () => {
    const { events, requested, providerBodies } = await runFixture();
    const injection = events.find(
      (event) =>
        event.type === "critic.flagged" && event.payload.category === "injection_suspected",
    );
    expect(injection).toBeDefined();
    const denial = events.find(
      (event) =>
        event.type === "policy.decided" &&
        event.payload.tool === "fetch_page" &&
        event.payload.decision === "deny",
    );
    expect(denial).toMatchObject({ payload: { policyId: "builtin" } });
    expect(requested.some((url) => new URL(url).hostname === "169.254.169.254")).toBe(false);
    expect(requested).toContain(`${FIXTURE_ORIGIN}/vs/robocorp`);
    for (const body of providerBodies) expect(JSON.stringify(body)).not.toContain(INJECTION);
  });

  it("gives privileged agents only typed, untrusted facts and no tools beyond their step", async () => {
    const { providerBodies } = await runFixture();
    const researcher = providerBodies.find((body) =>
      body.messages[0]?.content?.includes("You are the researcher"),
    );
    const synthesis = providerBodies.find((body) =>
      body.messages[0]?.content?.includes("You write the Company X-ray"),
    );
    const readers = providerBodies.filter((body) =>
      body.messages[0]?.content?.includes("quarantined reader"),
    );
    expect(readers.length).toBeGreaterThan(0);
    for (const reader of readers) expect(reader.tools).toBeUndefined();
    const toolless = providerBodies.filter((body) =>
      /You are the (planner|critic|editor)/.test(body.messages[0]?.content ?? ""),
    );
    expect(toolless.length).toBeGreaterThanOrEqual(3);
    for (const body of toolless) expect(body.tools).toBeUndefined();
    expect(synthesis?.tools).toBeUndefined();
    expect(
      (researcher?.tools ?? []).map(
        (tool) => (tool as { function: { name: string } }).function.name,
      ),
    ).toEqual(["fetch_page", "read_feed"]);
    const synthesisUser =
      synthesis?.messages.find((message) => message.role === "user")?.content ?? "";
    expect(synthesisUser).toContain('"trust":"untrusted"');
    expect(synthesisUser).not.toContain("<source");
    expect(synthesisUser).not.toContain("Robots that pick and pack</h1>");
  });

  it("streams agent messages without reasoning text and reports usage per call", async () => {
    const { events } = await runFixture();
    const messages = events.filter((event) => event.type === "agent.message");
    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages)
      expect(JSON.stringify(message)).not.toContain("hidden reasoning");
    const usageEvents = events.filter((event) => event.type === "usage.updated");
    expect(usageEvents.length).toBeGreaterThanOrEqual(3);
    for (const event of usageEvents) {
      expect(event.payload).toMatchObject({
        provider: "pollinations",
        model: "openai",
        costMicroUsd: 0,
        cacheReadTokens: 512,
        inputTokens: 688,
      });
    }
  });

  it("fails cleanly on invalid input", async () => {
    const { status, events } = await runFixture({ input: { url: "ftp://acme.example" } });
    expect(status).toBe("failed");
    expect(foldRun(events)).toMatchObject({ status: "failed", error: { code: "invalid_input" } });
  });

  it("fails the research step when the site cannot be read", async () => {
    const { status, events } = await runFixture({
      extra: (url) =>
        url.hostname === "www.acme.example" && url.pathname === "/"
          ? new Response("down", { status: 503 })
          : undefined,
    });
    expect(status).toBe("failed");
    const state = foldRun(events);
    expect(state.error?.code).toBe("site_unreachable");
    expect(state.steps[0]?.status).toBe("failed");
  });

  it("reports used-up free capacity as a typed failure with model.fallback recorded", async () => {
    const { status, events } = await runFixture({
      extra: (url) =>
        url.href === POLLINATIONS ? new Response("payment required", { status: 402 }) : undefined,
    });
    expect(status).toBe("failed");
    const state = foldRun(events);
    expect(state.error?.code).toBe("no_model_available");
    expect(state.fallbacks.length).toBeGreaterThan(0);
    expect(state.steps.find((step) => step.id === "read")?.status).toBe("failed");
  });
});

describe("plan review", () => {
  it("emits plan.revised with a diff for reviewer edits, then approves the edited version", async () => {
    const { status, events } = await runFixture({
      awaitPlanApproval: (plan) =>
        Promise.resolve({
          decision: "approved",
          steps: plan.steps
            .filter((step) => step.id !== "fill_gaps")
            .map((step) =>
              step.id === "synthesise" ? { ...step, inputs: ["read", "research_external"] } : step,
            ),
        }),
    });
    expect(status).toBe("completed");
    const revised = events.find((event) => event.type === "plan.revised");
    expect(revised).toMatchObject({
      payload: {
        version: 2,
        source: "reviewer",
        diff: { removed: ["fill_gaps"], changed: ["synthesise"], added: [] },
      },
    });
    expect(events.find((event) => event.type === "plan.approved")).toMatchObject({
      payload: { version: 2, approvedBy: { type: "member" } },
    });
    const state = foldRun(events);
    expect(state.steps.map((step) => step.id)).not.toContain("fill_gaps");
    expect(state.status).toBe("completed");
  });

  it("fails cleanly when the reviewer rejects the plan or submits an invalid edit", async () => {
    const rejected = await runFixture({
      awaitPlanApproval: () => Promise.resolve({ decision: "rejected", reason: "Not now" }),
    });
    expect(foldRun(rejected.events).error).toEqual({ code: "plan_rejected", message: "Not now" });
    expect(rejected.events.some((event) => event.type === "step.started")).toBe(false);
    const invalid = await runFixture({
      awaitPlanApproval: (plan) =>
        Promise.resolve({
          decision: "approved",
          steps: plan.steps.map((step) =>
            step.id === "read" ? { ...step, capabilities: ["message.send"] } : step,
          ),
        }),
    });
    expect(foldRun(invalid.events).error?.code).toBe("invalid_plan");
  });
});

describe("playbooks learned from past runs", () => {
  it("records lessons after a run and applies them, logged, on the next run", async () => {
    const playbooks = createMemoryPlaybookStore();
    const first = await runFixture({ playbooks, runId: "run_first" });
    expect(first.status).toBe("completed");
    expect(first.events.some((event) => event.type === "playbook.applied")).toBe(false);
    const learned = await playbooks.read("company-xray");
    expect(learned.house).toBeNull();
    expect(learned.workspace).toMatchObject({ version: 1, runs: 1, runIds: ["run_first"] });

    const second = await runFixture({ playbooks, runId: "run_second" });
    expect(second.status).toBe("completed");
    const types = second.events.map((event) => event.type);
    expect(types.indexOf("playbook.applied")).toBeLessThan(types.indexOf("plan.proposed"));
    const state = foldRun(second.events);
    expect(state.playbook).toMatchObject({
      key: "company-xray",
      runs: 1,
      sources: [{ scope: "workspace", version: 1 }],
    });
    const plannerUser = second.providerBodies
      .filter((body) => (body.messages[0]?.content ?? "").includes("You are the planner"))
      .map((body) => body.messages.find((message) => message.role === "user")?.content ?? "")
      .join("\n");
    expect(plannerUser).toContain('<playbook key="company-xray" runs="1"');
    for (const entry of state.playbook?.entries ?? []) expect(plannerUser).toContain(entry.id);
    expect((await playbooks.read("company-xray")).workspace?.version).toBe(2);
  });
});

describe("gap filling stays inside the time target", () => {
  it("skips the gap-filling agent when the chain's rate limits cannot fit it in the target", async () => {
    const providerBodies: string[] = [];
    const slowConfig = {
      ...unthrottledConfig,
      providers: unthrottledConfig.providers.map((provider) =>
        provider.id === "pollinations"
          ? { ...provider, limits: { requestsPerMinute: 1.5 } }
          : provider,
      ),
    };
    const site = fixtureFetch((url, init) => {
      if (url.href !== POLLINATIONS) return undefined;
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as WireBody;
      providerBodies.push(body.messages[0]?.content ?? "");
      const user = body.messages.find((message) => message.role === "user")?.content ?? "";
      return (body.messages[0]?.content ?? "").includes("quarantined reader")
        ? readerReply(user)
        : synthesisReply(user);
    });
    let clock = Date.parse("2026-11-24T10:00:00Z");
    const result = await runMission({
      runId: "run_slow",
      missionId: "company-xray",
      input: { url: `${FIXTURE_ORIGIN}/` },
      context: { audience: "public-demo", classification: "public" },
      env: {},
      emit: () => Promise.resolve(),
      fetchImpl: site.fetchImpl,
      resolveDns: fixtureDns,
      now: () => new Date(clock),
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
      modelsConfig: slowConfig,
    });
    expect(result.status).toBe("completed");
    expect(providerBodies.some((system) => system.includes("You are the researcher"))).toBe(false);
  });
});
