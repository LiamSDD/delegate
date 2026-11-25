import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createMemoryLeases } from "../../durable/lease";
import { foldRun, parseRunEvent, type RunEvent, type RunEventDraft } from "../../events";
import { createMemoryKnowledgeStore, createMemoryMemoryStore } from "../../knowledge/memory-store";
import { answerQuestion, resumeMission, runMission } from "../../server";
import { FIXTURE_ORIGIN, fixtureDns, fixtureFetch } from "../../testing/fixture-site";
import { type AnswerEvent } from "./answer";
import {
  AssistantArtifactSchema,
  AssistantEvalsSchema,
  GapsReportSchema,
  createMemoryAssistantStore,
} from "./schema";

const POLLINATIONS = "https://text.pollinations.ai/openai";
const rootConfig = JSON.parse(
  readFileSync(new URL("../../../../../config/models.json", import.meta.url), "utf8"),
) as { providers: { id: string; limits?: unknown }[] };
const unthrottledConfig = {
  ...rootConfig,
  providers: rootConfig.providers.map(({ limits: _limits, ...provider }) => provider),
};

interface WireBody {
  messages: { role: string; content: string | null }[];
}

function textReply(text: string): Response {
  const pieces = text.match(/[\s\S]{1,40}/g) ?? [];
  const chunks = [
    ...pieces.map((piece) => ({ choices: [{ index: 0, delta: { content: piece } }] })),
    {
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 500, completion_tokens: 100 },
    },
  ];
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}

function plannerReply(user: string): Response {
  const reference =
    /## Reference plan[^\n]*\n\n(\{[\s\S]*?\})\n\nReturn only/.exec(user)?.[1] ?? "{}";
  return textReply(reference);
}

function evalReply(user: string): Response {
  const passages = [...user.matchAll(/<passage id="(P\d+)"[^>]*>\n([\s\S]*?)\n<\/passage>/g)];
  const cases = passages.slice(0, 5).map(([, id = "", text = ""]) => {
    const line =
      text
        .split("\n")
        .find((candidate) => candidate.trim().length >= 20 && !candidate.startsWith("#")) ?? text;
    const quote = line.replace(/^- /, "").slice(0, 40).trim();
    return {
      question: `What does the site say about: ${quote}?`,
      passage: id,
      quote,
      expectedAnswer: quote,
    };
  });
  cases.push({
    question: "Where are robotics engineers hired?",
    passage: null as unknown as string,
    quote: null as unknown as string,
    expectedAnswer: "Not stated.",
  });
  cases.push({
    question: "Who is the CEO of Acme?",
    passage: null as unknown as string,
    quote: null as unknown as string,
    expectedAnswer: "Not stated.",
  });
  return textReply(JSON.stringify({ cases }));
}

function answerReply(user: string): Response {
  const question = /## Question\n([\s\S]*)$/.exec(user)?.[1] ?? "";
  return textReply(
    question.includes("CEO") ? "NOT_IN_SOURCES" : "The site states this directly [1].",
  );
}

function gradeReply(user: string): Response {
  const ids = user
    .split("\n")
    .filter((line) => line.startsWith('{"id"'))
    .map((line) => (JSON.parse(line) as { id: string }).id);
  return textReply(
    JSON.stringify({
      grades: ids.map((id) => ({ id, verdict: "pass", reason: "Matches the quote." })),
    }),
  );
}

function modelFetch() {
  const bodies: WireBody[] = [];
  const site = fixtureFetch((url, init) => {
    if (url.href !== POLLINATIONS) return undefined;
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as WireBody;
    bodies.push(body);
    const system = body.messages[0]?.content ?? "";
    const user =
      [...body.messages].reverse().find((message) => message.role === "user")?.content ?? "";
    if (system.includes("You are the planner")) return plannerReply(user);
    if (system.includes("You design a customer-facing"))
      return textReply(
        JSON.stringify({
          name: "Acme Leasing Help",
          persona: "You help warehouse managers understand Acme's robot leasing.",
          covers: ["pricing", "customers", "careers"],
          excludes: ["legal advice"],
          refusalPolicy: "I can only answer from Acme's website; please contact Acme.",
          starterQuestions: ["How much does a robot lease cost?"],
          expectedTopics: [
            "robot lease pricing",
            "customer results",
            "quantum teleportation warranty",
          ],
        }),
      );
    if (system.includes("You write an evaluation set")) return evalReply(user);
    if (system.includes("You rank search results")) {
      const count = [...user.matchAll(/<chunk id="C\d+"/g)].length;
      if (user.includes("CEO"))
        return textReply(
          JSON.stringify({
            ranking: Array.from({ length: count }, (_, index) => ({
              id: `C${index + 1}`,
              relevance: 0,
            })),
          }),
        );
      return textReply(
        JSON.stringify({
          ranking: Array.from({ length: count }, (_, index) => ({
            id: `C${index + 1}`,
            relevance: 2,
          })),
        }),
      );
    }
    if (system.includes("You answer questions about one company")) return answerReply(user);
    if (system.includes("You grade a website assistant")) return gradeReply(user);
    if (system.includes("You audit a company's public website"))
      return textReply('{"contradictions":[]}');
    return textReply("{}");
  });
  return { site, bodies };
}

const INPUT = {
  url: FIXTURE_ORIGIN,
  goal: "Answer prospects' questions about robot leasing, pricing and customer results.",
};

function eventLog(runId: string) {
  const events: RunEvent[] = [];
  const append = (draft: RunEventDraft) => {
    events.push(parseRunEvent({ ...draft, seq: events.length + 1, at: new Date().toISOString() }));
  };
  append({
    runId,
    type: "run.created",
    payload: {
      workspaceId: "ws_1",
      missionId: "build-agent",
      input: INPUT,
      actor: { type: "guest", id: "guest_1" },
      budget: { maxTokens: 300_000, maxMicroUsd: 0 },
    },
  });
  return { events, append };
}

function lastContent(events: readonly RunEvent[], kind: string): unknown {
  const created = events.find(
    (event) => event.type === "artifact.created" && event.payload.kind === kind,
  );
  const id = created?.type === "artifact.created" ? created.payload.artifactId : "";
  const updates = events.filter(
    (event) => event.type === "artifact.updated" && event.payload.artifactId === id,
  );
  const last = updates.at(-1);
  if (last?.type === "artifact.updated") return last.payload.content;
  return created?.type === "artifact.created" ? created.payload.content : undefined;
}

function common(
  stores: {
    knowledge: ReturnType<typeof createMemoryKnowledgeStore>;
    assistants: ReturnType<typeof createMemoryAssistantStore>;
  },
  fetchImpl: typeof fetch,
) {
  return {
    context: { audience: "public-demo" as const, classification: "public" as const },
    env: {},
    fetchImpl,
    resolveDns: fixtureDns,
    sleep: () => Promise.resolve(),
    modelsConfig: unthrottledConfig,
    knowledge: stores.knowledge,
    assistants: stores.assistants,
    embeddings: null,
  };
}

describe("build-agent mission", () => {
  it("crawls, indexes, designs, evaluates and reports gaps, then answers live with citations", async () => {
    const { site, bodies } = modelFetch();
    const stores = {
      knowledge: createMemoryKnowledgeStore(),
      assistants: createMemoryAssistantStore(),
    };
    const memory = createMemoryMemoryStore();
    const { events, append } = eventLog("run_build");
    const result = await runMission({
      ...common(stores, site.fetchImpl),
      runId: "run_build",
      missionId: "build-agent",
      input: INPUT,
      memory,
      emit: (draft) => {
        append(draft);
        return Promise.resolve();
      },
    });
    const state = foldRun(events);
    expect(state.error).toBeUndefined();
    expect(result.status).toBe("completed");
    const assistant = AssistantArtifactSchema.parse(lastContent(events, "assistant"));
    expect(assistant).toMatchObject({
      status: "ready",
      name: "Acme Leasing Help",
      retrieval: { mode: "full-text" },
    });
    expect(assistant.corpusStats.pages).toBeGreaterThanOrEqual(4);
    expect(assistant.corpusStats.flaggedChunks).toBeGreaterThanOrEqual(0);
    const evals = AssistantEvalsSchema.parse(lastContent(events, "assistant-evals"));
    expect(evals.total).toBeGreaterThanOrEqual(3);
    expect(
      evals.results.find((entry) =>
        (evals.cases.find((c) => c.id === entry.caseId)?.question ?? "").includes("CEO"),
      ),
    ).toMatchObject({ verdict: "pass", refused: true });
    expect(evals.passRate).not.toBeNull();
    expect(
      evals.cases.some((entry) => entry.question.startsWith("Where are robotics engineers")),
    ).toBe(false);
    const gaps = GapsReportSchema.parse(lastContent(events, "gaps-report"));
    expect(gaps.gaps.some((gap) => gap.kind === "unanswerable")).toBe(true);
    expect(stores.assistants.records.get(assistant.id)?.config.status).toBe("ready");
    expect(memory.entries.get("agents")).toEqual([
      expect.objectContaining({ assistantId: assistant.id, name: "Acme Leasing Help" }),
    ]);
    const checkpoint = events.find(
      (event) => event.type === "step.completed" && event.stepId === "crawl",
    );
    expect(
      checkpoint?.type === "step.completed" ? checkpoint.payload.checkpoint : undefined,
    ).toBeDefined();
    const designerCall = bodies.find((body) =>
      body.messages[0]?.content?.includes("You design a customer-facing"),
    );
    expect(designerCall?.messages.at(-1)?.content).toContain("untrusted web content");

    const streamed: AnswerEvent[] = [];
    for await (const event of answerQuestion({
      assistantId: assistant.id,
      question: "How much does it cost to lease a robot per month?",
      env: {},
      audience: "public-demo",
      modelsConfig: unthrottledConfig,
      fetchImpl: site.fetchImpl,
      assistants: stores.assistants,
      knowledge: stores.knowledge,
      embeddings: null,
      sleep: () => Promise.resolve(),
    }))
      streamed.push(event);
    expect(streamed.some((event) => event.type === "delta")).toBe(true);
    expect(streamed.find((event) => event.type === "citation")).toMatchObject({
      url: expect.stringContaining(FIXTURE_ORIGIN) as unknown,
    });
    expect(streamed.at(-1)).toMatchObject({ type: "done", grounded: true });

    const limited: AnswerEvent[] = [];
    for await (const event of answerQuestion({
      assistantId: assistant.id,
      question: "Pricing?",
      env: {},
      audience: "public-demo",
      modelsConfig: unthrottledConfig,
      assistants: stores.assistants,
      knowledge: stores.knowledge,
      rateLimit: () => Promise.resolve({ allowed: false, retryAfterMs: 5_000 }),
    }))
      limited.push(event);
    expect(limited[0]).toMatchObject({
      type: "refusal",
      reason: "rate_limited",
      retryAfterMs: 5_000,
    });
  });

  it("resumes after a crash without redoing finished steps, and only one worker holds the lease", async () => {
    const { site } = modelFetch();
    const stores = {
      knowledge: createMemoryKnowledgeStore(),
      assistants: createMemoryAssistantStore(),
    };
    const { events, append } = eventLog("run_crash");
    const controller = new AbortController();
    let killed = false;
    const first = await runMission({
      ...common(stores, site.fetchImpl),
      runId: "run_crash",
      missionId: "build-agent",
      input: INPUT,
      signal: controller.signal,
      emit: (draft) => {
        if (killed) return Promise.reject(new Error("process killed"));
        append(draft);
        if (draft.type === "step.started" && draft.stepId === "evaluate") {
          killed = true;
          controller.abort();
        }
        return Promise.resolve();
      },
    });
    expect(first.status).toBe("failed");
    expect(foldRun(events).status).toBe("running");
    const killedAt = events.length;
    const pageFetches = site.requested.filter((url) => url.startsWith(FIXTURE_ORIGIN)).length;

    const leases = createMemoryLeases();
    leases.lease("run_crash", "other-worker", 60_000);
    await leases.lease("run_crash", "other-worker", 60_000).acquire();
    const blocked = await resumeMission({
      ...common(stores, site.fetchImpl),
      runId: "run_crash",
      events,
      lease: leases.lease("run_crash", "worker-2", 60_000),
      emit: (draft) => {
        append(draft);
        return Promise.resolve();
      },
    });
    expect(blocked.status).toBe("busy");
    expect(events.length).toBe(killedAt);
    await leases.lease("run_crash", "other-worker", 60_000).release();

    const resumed = await resumeMission({
      ...common(stores, site.fetchImpl),
      runId: "run_crash",
      events: [...events],
      lease: leases.lease("run_crash", "worker-2", 60_000),
      emit: (draft) => {
        append(draft);
        return Promise.resolve();
      },
    });
    expect(resumed).toMatchObject({
      status: "completed",
      resumed: true,
      skippedSteps: ["crawl", "index", "design", "evalset"],
      rerunSteps: ["evaluate", "gaps"],
    });
    const after = events.slice(killedAt);
    const restarted = after
      .filter((event) => event.type === "step.started")
      .map((event) => event.stepId);
    expect(restarted).toEqual(["evaluate", "gaps"]);
    expect(
      after.some((event) => event.type === "plan.proposed" || event.type === "plan.approved"),
    ).toBe(false);
    expect(site.requested.filter((url) => url.startsWith(FIXTURE_ORIGIN)).length).toBe(pageFetches);
    expect(foldRun(events).status).toBe("completed");
    const evalArtifacts = events.filter(
      (event) => event.type === "artifact.created" && event.payload.kind === "assistant-evals",
    );
    expect(evalArtifacts).toHaveLength(1);
    expect([...stores.assistants.records.values()][0]?.config.status).toBe("ready");
    expect(leases.holders.has("run_crash")).toBe(false);

    const again = await resumeMission({
      ...common(stores, site.fetchImpl),
      runId: "run_crash",
      events,
      emit: () => Promise.reject(new Error("must not emit")),
    });
    expect(again).toMatchObject({ status: "completed", resumed: false });
  });
});
