import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { checkPlanSteps } from "../../agent/planner";
import { foldRun, parseRunEvent, type RunEvent, type RunEventDraft } from "../../events";
import { type AwaitPlanApproval } from "../../plan-approval";
import { loadRuntimePrompts, resumeMission, runMission } from "../../server";
import { createFetcher } from "../../tools/fetch";
import { fixtureDns, fixtureFetch } from "../../testing/fixture-site";
import { scriptedProvider, testRun, textTurn } from "../../testing/fakes";
import { NextActionsSchema } from "../next-actions";
import { defaultGoalPlan } from "./plan";
import { createCustomGoalMission, goalNextActions } from "./run";
import { GoalBriefSchema, type GoalBrief } from "./schema";

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

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

function textReply(text: string): Response {
  const pieces = text.match(/[\s\S]{1,60}/g) ?? [];
  const body =
    [
      ...pieces.map((piece) => ({ choices: [{ index: 0, delta: { content: piece } }] })),
      {
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 900, completion_tokens: 200 },
      },
    ]
      .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
      .join("") + "data: [DONE]\n\n";
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function readerReply(user: string): Response {
  const sources = [
    ...user.matchAll(/<source id="(S\d+)" label="([^"]*)">\n([\s\S]*?)\n<\/source>/g),
  ].map(([, sourceId = "", label = "", text = ""]) => {
    const line =
      text
        .split("\n")
        .find((candidate) => candidate.trim().length >= 20 && !candidate.startsWith("#")) ?? text;
    const words = line.replace(/^(Description: |- )/, "").split(/\s+/);
    const quote = words.slice(0, 14).join(" ").trim();
    return {
      sourceId,
      facts:
        quote.length >= 8
          ? [
              {
                claim: `Source states: ${quote}`,
                quote,
                topic: label.startsWith("company_site") ? "company" : "practice",
              },
            ]
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
  const company = facts.filter((fact) => fact.topic === "company");
  const practice = facts.filter((fact) => fact.topic === "practice");
  const first = (list: typeof facts) => list[0] ?? facts[0];
  const cite = (fact: (typeof facts)[number] | undefined) => ({
    text: fact?.claim ?? "none",
    citations: [fact?.sourceId ?? "S1"],
  });
  return textReply(
    JSON.stringify({
      objective: "Raise marketing reach and automate repetitive work with agents.",
      workstreams: [
        { name: "Marketing", findings: practice.slice(0, 2).map(cite) },
        { name: "Company context", findings: company.slice(0, 2).map(cite) },
        { name: "Invented", findings: [{ text: "Made up market share.", citations: ["S99"] }] },
      ],
      actions: [
        {
          title: "Map the order-handling workflow for automation",
          owner: "Head of Operations",
          effort: "Medium",
          impact: "high",
          mission: "automation-audit",
          basis: cite(first(company)),
        },
        {
          title: "Launch a customer help assistant on the public site",
          owner: "Head of Support",
          effort: "low",
          impact: "medium",
          mission: "build-agent",
          basis: cite(first(company)),
        },
        {
          title: "Define campaign metrics",
          owner: "Head of Marketing",
          effort: "low",
          impact: "high",
          mission: "not-a-mission",
          basis: cite(first(practice)),
        },
        {
          title: "Uncited action",
          owner: "CEO",
          effort: "low",
          impact: "high",
          mission: null,
          basis: { text: "No source says this.", citations: ["S42"] },
        },
      ],
      risks: [cite(first(practice))],
      openQuestions: ["What budget is available?"],
    }),
  );
}

function plannerReply(user: string): Response {
  const reference =
    /## Reference plan[^\n]*\n\n(\{[\s\S]*?\})\n\nReturn only/.exec(user)?.[1] ?? "{}";
  const { steps } = JSON.parse(reference) as { steps: unknown[] };
  return textReply(JSON.stringify({ steps, rationale: "The reference plan fits this goal." }));
}

function criticReply(user: string): Response {
  const results = user
    .split("\n")
    .filter((line) => line.startsWith('{"id"'))
    .map((line) => {
      const { id, claim } = JSON.parse(line) as { id: string; claim: string };
      const verdict =
        id.startsWith("risk") && !claim.startsWith("Narrowed:") ? "not_enough_info" : "supported";
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

function referenceApi(url: URL): Response | undefined {
  if (url.hostname === "en.wikipedia.org" && url.pathname === "/w/api.php") {
    if (url.searchParams.get("list") === "search") {
      const query = url.searchParams.get("srsearch") ?? "";
      return json({
        query: { search: [{ title: query === "marketing" ? "Marketing" : "Software agent" }] },
      });
    }
    if (url.searchParams.get("prop") === "extracts")
      return json({
        query: {
          pages: {
            "1": {
              title: "Marketing",
              extract:
                "Marketing is the act of acquiring, satisfying and retaining customers. It is one of the primary components of business management and commerce.",
            },
            "2": {
              title: "Software agent",
              extract:
                "A software agent is a computer program that acts for a user or another program in a relationship of agency, deciding which actions are appropriate.",
            },
          },
        },
      });
  }
  if (url.hostname === "www.wikidata.org" && url.searchParams.get("search") === "acme")
    return json({ search: [{ id: "Q7" }, { id: "Q8" }] });
  if (url.hostname === "www.wikidata.org" && url.searchParams.get("ids") === "Q7|Q8")
    return json({
      entities: {
        Q7: { labels: { en: { value: "Acme" } }, claims: {} },
        Q8: {
          labels: { en: { value: "Acme Robotics" } },
          claims: { P856: [{ mainsnak: { datavalue: { value: "https://www.acme.example" } } }] },
        },
      },
    });
  return undefined;
}

async function runGoal(
  goal: string,
  awaitPlanApproval?: AwaitPlanApproval,
  options: { hardDeadlineMs?: number; killAt?: string } = {},
): Promise<{
  status: string;
  events: RunEvent[];
  requested: string[];
  resume: () => ReturnType<typeof resumeMission>;
}> {
  const site = fixtureFetch((url, init) => {
    const api = referenceApi(url);
    if (api !== undefined) return api;
    if (url.href !== POLLINATIONS) return undefined;
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as WireBody;
    const system = body.messages[0]?.content ?? "";
    const user = body.messages.find((message) => message.role === "user")?.content ?? "";
    if (system.includes("quarantined reader")) return readerReply(user);
    if (system.includes("You are the planner")) return plannerReply(user);
    if (system.includes("You are the critic")) return criticReply(user);
    if (system.includes("You are the editor of Delegate.")) return editorReply(user);
    if (system.includes("You write a goal brief")) return synthesisReply(user);
    return textReply("{}");
  });
  const events: RunEvent[] = [];
  const append = (draft: RunEventDraft) => {
    events.push(parseRunEvent({ ...draft, seq: events.length + 1, at: new Date().toISOString() }));
  };
  append({
    runId: "run_goal",
    type: "run.created",
    payload: {
      workspaceId: "ws_1",
      missionId: "custom-goal",
      input: { goal },
      actor: { type: "guest", id: "guest_1" },
      budget: { maxTokens: 300_000, maxMicroUsd: 0 },
    },
  });
  const common = {
    runId: "run_goal",
    context: { audience: "public-demo" as const, classification: "public" as const },
    env: {},
    fetchImpl: site.fetchImpl,
    resolveDns: fixtureDns,
    sleep: () => Promise.resolve(),
    modelsConfig: unthrottledConfig,
    ...(options.hardDeadlineMs === undefined ? {} : { hardDeadlineMs: options.hardDeadlineMs }),
  };
  const controller = new AbortController();
  let killed = false;
  const result = await runMission({
    ...common,
    missionId: "custom-goal",
    input: { goal },
    signal: controller.signal,
    emit: (draft) => {
      if (killed) return Promise.reject(new Error("process killed"));
      append(draft);
      if (draft.type === "step.started" && draft.stepId === options.killAt) {
        killed = true;
        controller.abort();
      }
      return Promise.resolve();
    },
    ...(awaitPlanApproval === undefined ? {} : { awaitPlanApproval }),
  });
  const resume = () =>
    resumeMission({
      ...common,
      events: [...events],
      emit: (draft) => {
        append(draft);
        return Promise.resolve();
      },
    });
  return { status: result.status, events, requested: site.requested, resume };
}

function finalBrief(events: readonly RunEvent[]): GoalBrief {
  const last = events.filter((event) => event.type === "artifact.updated").at(-1);
  if (last?.type !== "artifact.updated") throw new Error("no brief");
  return GoalBriefSchema.parse(last.payload.content);
}

describe("runMission custom-goal end to end (fixture web, scripted model over HTTP)", () => {
  it("resolves a brand-only company, plans, researches, writes a cited brief and offers follow-ups", async () => {
    const { status, events, requested } = await runGoal(
      "I want to achieve acme's marketing and agentic work",
    );
    expect(status).toBe("completed");
    const state = foldRun(events);
    expect(state.status).toBe("completed");
    expect(state.steps.every((step) => step.status === "succeeded")).toBe(true);
    expect(state.steps.map((step) => step.id).sort()).toEqual([
      "critic",
      "read",
      "research",
      "research_external",
      "research_topic",
      "resolve_target",
      "synthesise",
    ]);
    expect(requested.some((url) => url.includes("search=acme"))).toBe(true);
    expect(requested).toContain("https://www.acme.example/");
    expect(
      events.some(
        (event) => event.type === "policy.decided" && event.payload.tool === "resolve_company",
      ),
    ).toBe(true);

    const brief = finalBrief(events);
    expect(brief.status).toBe("complete");
    expect(brief.company).toMatchObject({
      name: "Acme Robotics",
      url: "https://www.acme.example/",
      resolvedBy: "wikidata",
      entity: "Q8",
    });
    expect(brief.workstreams.map((stream) => stream.name)).toEqual([
      "Marketing",
      "Company context",
    ]);
    expect(brief.actions.map((action) => [action.rank, action.title, action.mission])).toEqual([
      [1, "Define campaign metrics", null],
      [2, "Launch a customer help assistant on the public site", "build-agent"],
      [3, "Map the order-handling workflow for automation", "automation-audit"],
    ]);
    expect(brief.actions[2]).toMatchObject({ effort: "medium", impact: "high", score: 1.5 });
    expect(brief.risks[0]?.text).toMatch(/^Narrowed:/);
    const sourceIds = new Set(brief.sources.map((source) => source.sourceId));
    const claims = [
      ...brief.workstreams.flatMap((stream) => stream.findings),
      ...brief.actions.map((action) => action.basis),
      ...brief.risks,
    ];
    expect(claims.length).toBeGreaterThan(0);
    for (const claim of claims)
      for (const citation of claim.citations) expect(sourceIds.has(citation)).toBe(true);
    expect(brief.sources.some((source) => source.kind === "wikipedia")).toBe(true);
    expect(brief.sources.some((source) => source.kind === "company_site")).toBe(true);

    expect(
      events.filter((event) => event.type === "critic.flagged").map((event) => event.payload.claim),
    ).toEqual(expect.arrayContaining(["Made up market share.", "No source says this."]));

    const next = events.find(
      (event) => event.type === "artifact.created" && event.payload.kind === "next-actions",
    );
    if (next?.type !== "artifact.created") throw new Error("no next actions");
    const actions = NextActionsSchema.parse(next.payload.content).actions;
    expect(actions.map((action) => [action.missionId, action.available, action.input.url])).toEqual(
      [
        ["build-agent", true, "https://www.acme.example/"],
        ["automation-audit", true, "https://www.acme.example/"],
        ["company-xray", true, "https://www.acme.example/"],
      ],
    );
    const completed = events.at(-1);
    expect(completed?.type).toBe("run.completed");
  });

  it("runs a topic-only plan when no company is named and honours plan review", async () => {
    let reviewed = 0;
    const { status, events, requested } = await runGoal(
      "Make our marketing planning more agentic",
      (proposal) => {
        reviewed = proposal.steps.length;
        return Promise.resolve({ decision: "approved" });
      },
    );
    expect(status).toBe("completed");
    expect(reviewed).toBe(4);
    expect(foldRun(events).steps.map((step) => step.id)).toEqual([
      "resolve_target",
      "research_topic",
      "synthesise",
      "critic",
    ]);
    expect(events.find((event) => event.type === "plan.approved")).toMatchObject({
      payload: { approvedBy: { type: "member" } },
    });
    expect(requested.some((url) => url.includes("wikidata"))).toBe(false);
    expect(requested.some((url) => url.includes("srsearch=marketing+agentic"))).toBe(true);
    const brief = finalBrief(events);
    expect(brief.company).toBeNull();
    expect(brief.actions.length).toBeGreaterThan(0);
    const next = events.find(
      (event) => event.type === "artifact.created" && event.payload.kind === "next-actions",
    );
    if (next?.type !== "artifact.created") throw new Error("no next actions");
    expect(NextActionsSchema.parse(next.payload.content).actions).toEqual([
      expect.objectContaining({ missionId: "automation-audit", available: false }),
    ]);
  });
});

describe("custom-goal time limit and resume", () => {
  const GOAL = "I want to achieve acme's marketing and agentic work";

  it("skips research past the hard deadline and still publishes a cited, partial brief", async () => {
    const { status, events, requested } = await runGoal(GOAL, undefined, { hardDeadlineMs: 0 });
    expect(status).toBe("completed");
    expect(requested.some((url) => url.startsWith("https://www.acme.example/"))).toBe(false);
    expect(requested.some((url) => url.includes("prop=extracts"))).toBe(false);
    const brief = finalBrief(events);
    expect(brief.partial?.skippedSteps).toEqual(
      expect.arrayContaining(["research", "research_topic"]),
    );
    expect(
      events.some(
        (event) => event.type === "critic.flagged" && event.payload.claimId === "deadline:partial",
      ),
    ).toBe(true);
    expect(foldRun(events).status).toBe("completed");
  });

  for (const killAt of ["read", "critic"])
    it(`resumes after a crash at ${killAt} from checkpoints without refetching`, async () => {
      const run = await runGoal(GOAL, undefined, { killAt });
      expect(run.status).toBe("failed");
      expect(foldRun(run.events).status).toBe("running");
      const killedAt = run.events.length;
      const fetchedBefore = run.requested.length;
      const resumed = await run.resume();
      expect(resumed).toMatchObject({ status: "completed", resumed: true });
      expect(resumed.skippedSteps).toEqual(
        expect.arrayContaining(["resolve_target", "research", "research_topic"]),
      );
      const restarted = run.events
        .slice(killedAt)
        .filter((event) => event.type === "step.started")
        .map((event) => event.stepId);
      expect(restarted).not.toContain("research");
      expect(restarted).not.toContain("resolve_target");
      const refetched = run.requested.slice(fetchedBefore);
      expect(refetched.some((url) => url.includes("search=acme&"))).toBe(false);
      expect(refetched.some((url) => url.includes("prop=extracts"))).toBe(false);
      expect(
        refetched.filter(
          (url) =>
            url.startsWith("https://www.acme.example/") &&
            !url.endsWith("/robots.txt") &&
            !url.includes("feed"),
        ),
      ).toEqual([]);
      const brief = finalBrief(run.events);
      expect(brief.status).toBe("complete");
      expect(brief.company?.url).toBe("https://www.acme.example/");
      expect(brief.sources.some((source) => source.kind === "company_site")).toBe(true);
      expect(brief.sources.some((source) => source.kind === "wikipedia")).toBe(true);
    });
});

describe("custom-goal plan validation", () => {
  const { ctx } = testRun({ provider: scriptedProvider("scripted", [textTurn("{}")]) });
  const fetcher = createFetcher({ fetchImpl: fixtureFetch().fetchImpl, resolveDns: fixtureDns });
  const prompts = loadRuntimePrompts();
  const mission = createCustomGoalMission({
    ctx,
    input: { goal: "Grow acme's marketing" },
    fetcher,
    prompts,
  });

  it("accepts both default plans and enforces the 3–8 step bound and required steps", () => {
    expect(checkPlanSteps(defaultGoalPlan(true), mission.planner).ok).toBe(true);
    expect(checkPlanSteps(defaultGoalPlan(false), mission.planner).ok).toBe(true);
    const tooShort = defaultGoalPlan(false)
      .filter((step) => step.id !== "critic")
      .slice(0, 2);
    const checked = checkPlanSteps(tooShort, mission.planner);
    expect(checked.ok).toBe(false);
    if (!checked.ok) {
      expect(checked.issues.join("; ")).toMatch(/at least 3/);
      expect(checked.issues.join("; ")).toMatch(/must include step critic/);
    }
  });

  it("rejects capabilities a step cannot use", () => {
    const plan = defaultGoalPlan(false).map((step) =>
      step.id === "synthesise" ? { ...step, capabilities: ["web.fetch", "artifact.write"] } : step,
    );
    const checked = checkPlanSteps(plan, mission.planner);
    expect(checked.ok).toBe(false);
  });
});

describe("goalNextActions", () => {
  it("offers Repo X-ray with the repository named in the goal", () => {
    const actions = goalNextActions(
      { workstreams: [], actions: [], risks: [], openQuestions: [] },
      null,
      "https://github.com/vercel/next.js",
    );
    expect(actions).toEqual([
      expect.objectContaining({
        missionId: "repo-xray",
        available: true,
        input: { url: "https://github.com/vercel/next.js" },
      }),
    ]);
  });

  it("routes a Ship-a-PR action through Repo X-ray, which supplies the improvement to ship", () => {
    const basis = {
      text: "The parser has no tests.",
      citations: ["S1"],
      trust: "derived" as const,
    };
    const sections = {
      workstreams: [],
      actions: [
        {
          rank: 1,
          score: 3,
          title: "Add parser tests",
          owner: "Engineering",
          effort: "low" as const,
          impact: "high" as const,
          mission: "ship-a-pr" as const,
          basis,
        },
      ],
      risks: [],
      openQuestions: [],
    } as unknown as Parameters<typeof goalNextActions>[0];
    const withRepo = goalNextActions(sections, null, "https://github.com/acme/widgets");
    expect(withRepo).toEqual([
      expect.objectContaining({
        id: "ship-via-repo-xray",
        missionId: "repo-xray",
        available: true,
        input: { url: "https://github.com/acme/widgets" },
      }),
    ]);
    const withoutRepo = goalNextActions(sections, null, null);
    expect(withoutRepo).toEqual([
      expect.objectContaining({ missionId: "ship-a-pr", available: false }),
    ]);
  });
});
