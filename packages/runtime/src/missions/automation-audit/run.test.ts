import { describe, expect, it } from "vitest";

import { foldRun, parseRunEvent, type RunEvent, type RunEventDraft } from "../../events";
import { runMission, type RunMissionOptions } from "../../server";
import { FIXTURE_ORIGIN, fixtureDns, fixtureFetch } from "../../testing/fixture-site";
import { maxQualityNotes, maxQualityRun, stepsServedOffline } from "../../testing/max-quality";
import { BuildAgentInputSchema } from "../build-agent/input";
import { NextActionsSchema } from "../next-actions";
import { matchGeneric } from "./genericity";
import { estimateRoi } from "./roi";
import { AutomationAuditSchema, type AutomationAudit } from "./schema";

const POLLINATIONS = "https://text.pollinations.ai/openai";

const rootConfig = JSON.parse(
  readFileSync(new URL("../../../../../config/models.json", import.meta.url), "utf8"),
) as { providers: { id: string; limits?: unknown }[] };
const unthrottledConfig = {
  ...rootConfig,
  providers: rootConfig.providers.map(({ limits: _limits, ...provider }) => provider),
};

import { readFileSync } from "node:fs";

interface WireBody {
  messages: { role: string; content: string | null }[];
  tools?: unknown[];
}

function textReply(text: string): Response {
  const pieces = text.match(/[\s\S]{1,60}/g) ?? [];
  const chunks = [
    ...pieces.map((piece) => ({ choices: [{ index: 0, delta: { content: piece } }] })),
    {
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 900, completion_tokens: 200 },
    },
  ];
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
    {
      headers: { "content-type": "text/event-stream" },
    },
  );
}

function jsonLines(user: string, prefix: string): Record<string, unknown>[] {
  return user
    .split("\n")
    .filter((line) => line.startsWith(prefix))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
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
    const topic = /careers/i.test(label)
      ? "hiring"
      : /pricing/i.test(label)
        ? "pricing"
        : /customers/i.test(label)
          ? "customers"
          : "offering";
    return { sourceId, facts: quote.length >= 8 ? [{ claim: quote, quote, topic }] : [] };
  });
  return textReply(JSON.stringify({ sources }));
}

const LENS_IDEAS: Record<string, [string, string, number][]> = {
  Operations: [
    ["Pick-rate reports for 3PL warehouse clients", "Northwind", 60],
    ["Robot fleet incident triage", "Kubernetes", 30],
  ],
  "Sales & Customer Success": [
    ["Lease quote drafting from the pricing sheet", "1,900 EUR", 40],
    ["Case-study drafts from Northwind-style results", "Northwind", 20],
  ],
  "Finance & Back-office": [
    ["Per-robot lease invoice reconciliation", "1,900 EUR", 80],
    ["Screening robotics engineer applicants in Berlin and Austin", "Berlin", 25],
  ],
  "Engineering & Product": [
    ["SAP and Manhattan WMS integration ticket triage", "Manhattan", 50],
    ["Fleet-sim release notes from Rust repositories", "fleet", 10],
  ],
};

function analystReply(user: string): Response {
  const department = /Department lens: ([^(]+) \(/.exec(user)?.[1]?.trim() ?? "Operations";
  const facts = jsonLines(user, '{"sourceId"') as { sourceId: string; quote?: string }[];
  const factFor = (term: string) => facts.find((fact) => fact.quote?.includes(term)) ?? facts[0];
  const candidate = (title: string, term: string, frequency: number, extra = "") => {
    const fact = factFor(term);
    return {
      title,
      workflow: `Staff handle ${title.toLowerCase()} by hand today; the evidence says: ${fact?.quote ?? term}.${extra}`,
      automation: `An agent drafts ${title.toLowerCase()} for human review.`,
      frequencyPerMonth: frequency,
      minutesPerTask: "20 minutes",
      peopleInvolved: 2,
      adoptionRate: 0.95,
      difficulty: "medium",
      risks: "Wrong numbers reach a customer",
      integrations: ["SAP"],
      firstStep: "Collect ten recent examples.",
      evidence: [
        { text: fact?.quote ?? term, citations: [fact?.sourceId ?? "S1"] },
        ...(title.startsWith("Robot fleet")
          ? [{ text: "UNSUPPORTED: 400 incidents a month.", citations: [fact?.sourceId ?? "S1"] }]
          : []),
      ],
      assumptions: [`${frequency} occurrences per person per month (assumed).`],
    };
  };
  if (user.includes("## Rejected candidates")) {
    return textReply(
      JSON.stringify({
        candidates: [candidate(`${department} weekly KPI digest for Northwind`, "Northwind", 5)],
      }),
    );
  }
  const ideas = LENS_IDEAS[department] ?? [];
  return textReply(
    JSON.stringify({
      candidates: [
        ...ideas.map(([title, term, frequency]) => candidate(title, term, frequency)),
        {
          title: "Use AI for customer support",
          workflow: "Use AI for customer support to answer common questions.",
          automation: "A chatbot answers questions.",
          evidence: [{ text: "Acme has customers.", citations: ["S1"] }],
        },
        {
          title: "Market leadership memo",
          workflow: "Write memos.",
          automation: "Drafts memos.",
          evidence: [{ text: "x", citations: ["S99"] }],
        },
      ],
    }),
  );
}

function auditEditorReply(user: string, picks = 6): Response {
  const ids = jsonLines(user, '{"id"').map((line) => String(line.id));
  return textReply(
    JSON.stringify({
      company: "Acme Robotics",
      picks: ids.slice(0, picks),
      notes: "Kept six distinct ideas.",
    }),
  );
}

function criticReply(user: string, forced?: string, contradict?: RegExp): Response {
  const results = jsonLines(user, '{"id"').map((line) => ({
    id: line.id,
    atoms: [
      {
        text: "atom",
        verdict:
          forced ??
          (contradict?.test(String(line.id)) === true
            ? "contradicted"
            : String(line.claim).startsWith("UNSUPPORTED")
              ? "not_enough_info"
              : "supported"),
      },
    ],
  }));
  return textReply(JSON.stringify({ results }));
}

function fixReply(user: string): Response {
  return textReply(
    JSON.stringify({
      fixes: jsonLines(user, '{"id"').map((line) => ({ id: line.id, action: "remove" })),
    }),
  );
}

function plannerReply(user: string): Response {
  const reference =
    /## Reference plan[^\n]*\n\n(\{[\s\S]*?\})\n\nReturn only/.exec(user)?.[1] ?? "{}";
  return textReply(
    JSON.stringify({ ...(JSON.parse(reference) as object), rationale: "Reference plan." }),
  );
}

async function runAudit(
  input: unknown,
  verdict?: "not_enough_info" | "contradicted",
  options: {
    editorPicks?: number;
    contradict?: RegExp;
    mission?: Partial<RunMissionOptions>;
  } = {},
): Promise<{ status: string; events: RunEvent[]; bodies: WireBody[] }> {
  const bodies: WireBody[] = [];
  const site = fixtureFetch((url, init) => {
    if (url.href !== POLLINATIONS) return undefined;
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as WireBody;
    bodies.push(body);
    const system = body.messages[0]?.content ?? "";
    const user = body.messages.find((message) => message.role === "user")?.content ?? "";
    if (system.includes("quarantined reader")) return readerReply(user);
    if (system.includes("You are the planner")) return plannerReply(user);
    if (system.includes("You are an analyst")) return analystReply(user);
    if (system.includes("Automation Audit. Analysts proposed"))
      return auditEditorReply(user, options.editorPicks);
    if (system.includes("You are the critic"))
      return criticReply(user, verdict, options.contradict);
    if (system.includes("You are the editor of Delegate."))
      return verdict === undefined ? fixReply(user) : textReply(JSON.stringify({ fixes: [] }));
    if (system.includes("You are the researcher")) return textReply("Nothing more to fetch.");
    return textReply("{}");
  });
  const events: RunEvent[] = [];
  const append = (draft: RunEventDraft) => {
    events.push(parseRunEvent({ ...draft, seq: events.length + 1, at: new Date().toISOString() }));
  };
  append({
    runId: "run_audit",
    type: "run.created",
    payload: {
      workspaceId: "ws_1",
      missionId: "automation-audit",
      input: {},
      actor: { type: "guest", id: "guest_1" },
      budget: { maxTokens: 300_000, maxMicroUsd: 0 },
    },
  });
  const result = await runMission({
    runId: "run_audit",
    missionId: "automation-audit",
    input,
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
    ...options.mission,
  });
  return { status: result.status, events, bodies };
}

function finalAudit(events: readonly RunEvent[]): AutomationAudit {
  const created = events.find(
    (event) => event.type === "artifact.created" && event.payload.kind === "automation-audit",
  );
  const id = created?.type === "artifact.created" ? created.payload.artifactId : "";
  const last = events
    .filter((event) => event.type === "artifact.updated" && event.payload.artifactId === id)
    .at(-1);
  return AutomationAuditSchema.parse(
    last?.type === "artifact.updated" ? last.payload.content : undefined,
  );
}

describe("runMission automation-audit end to end (fixture site, fake provider over HTTP)", () => {
  it("runs four analyst lanes in parallel and ships a ranked, cited, company-specific audit", async () => {
    const { status, events, bodies } = await runAudit({ url: `${FIXTURE_ORIGIN}/` });
    expect(status).toBe("completed");
    const state = foldRun(events);
    expect(state.status).toBe("completed");
    const lanes = ["analyse_ops", "analyse_sales", "analyse_finance", "analyse_engineering"];
    const starts = events.flatMap((event, index) =>
      event.type === "step.started" && lanes.includes(event.stepId) ? [index] : [],
    );
    const firstLaneDone = events.findIndex(
      (event) => event.type === "step.completed" && lanes.includes(event.stepId),
    );
    expect(starts).toHaveLength(4);
    expect(Math.max(...starts)).toBeLessThan(firstLaneDone);

    const audit = finalAudit(events);
    expect(audit.company).toBe("Acme Robotics");
    expect(audit.opportunities.length).toBeGreaterThanOrEqual(5);
    expect(audit.opportunities.length).toBeLessThanOrEqual(8);
    const values = audit.opportunities.map((opportunity) => estimateRoi(opportunity).eurPerMonth);
    expect(values).toEqual([...values].sort((a, b) => b - a));
    for (const opportunity of audit.opportunities) {
      expect(matchGeneric(opportunity.workflow)).toBeUndefined();
      expect(opportunity.adoptionRate).toBeLessThanOrEqual(0.7);
      expect(opportunity.assumptions.join(" ")).toMatch(/clamped|assumed/);
      expect(JSON.stringify(opportunity)).not.toContain("UNSUPPORTED");
      expect(JSON.stringify(opportunity)).not.toContain("S99");
    }
    const rejected = events.filter(
      (event) => event.type === "critic.flagged" && /^\w+:generic:/.test(event.payload.claimId),
    );
    expect(rejected.length).toBeGreaterThanOrEqual(8);
    const criticDone = events.find(
      (event) => event.type === "step.completed" && event.stepId === "critic",
    );
    expect(criticDone).toMatchObject({
      payload: { critic: { removed: 1, citationAccuracy: expect.any(Number) as unknown } },
    });

    const next = events.find(
      (event) => event.type === "artifact.created" && event.payload.kind === "next-actions",
    );
    const actions = NextActionsSchema.parse(
      next?.type === "artifact.created" ? next.payload.content : undefined,
    );
    expect(actions.actions).toHaveLength(audit.opportunities.length);
    expect(
      actions.actions.every((action) => action.missionId === "build-agent" && action.available),
    ).toBe(true);
    for (const [index, action] of actions.actions.entries()) {
      const opportunity = audit.opportunities[index];
      expect(BuildAgentInputSchema.parse(action.input)).toMatchObject({
        url: expect.stringContaining("acme.example") as unknown,
        goal: opportunity?.automation,
        opportunityId: opportunity?.id,
        fromAuditRunId: "run_audit",
      });
    }

    const readers = bodies.filter((body) =>
      body.messages[0]?.content?.includes("quarantined reader"),
    );
    expect(readers.length).toBeGreaterThan(1);
    for (const body of readers) expect(JSON.stringify(body).match(/<source id=/g)).toHaveLength(1);
    const analysts = bodies.filter((body) =>
      body.messages[0]?.content?.includes("You are an analyst"),
    );
    for (const body of analysts) {
      expect(body.tools).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain("<source");
    }
  });

  it("routes only the ranking step to the offline entry in max quality", async () => {
    const { status, events } = await runAudit({ url: `${FIXTURE_ORIGIN}/` }, undefined, {
      mission: maxQualityRun(unthrottledConfig),
    });
    expect(status).toBe("completed");
    expect(stepsServedOffline(events)).toEqual(["rank"]);
    expect(maxQualityNotes(events)).toEqual(["rank"]);
  });

  it("narrows the plan to the requested department", async () => {
    const { status, events } = await runAudit({ url: `${FIXTURE_ORIGIN}/`, department: "Finance" });
    expect(status).toBe("completed");
    const proposed = events.find((event) => event.type === "plan.proposed");
    const ids =
      proposed?.type === "plan.proposed" ? proposed.payload.steps.map((step) => step.id) : [];
    expect(ids.filter((id) => id.startsWith("analyse_"))).toEqual(["analyse_finance"]);
  });

  it("labels every opportunity with the requested department", async () => {
    const { status, events } = await runAudit({ url: `${FIXTURE_ORIGIN}/`, department: "Support" });
    expect(status).toBe("completed");
    const audit = finalAudit(events);
    expect(audit.opportunities.length).toBeGreaterThan(0);
    expect(audit.opportunities.every((opportunity) => opportunity.department === "Support")).toBe(
      true,
    );
  });

  it("keeps weakly supported opportunities, marks them and still reports citation accuracy", async () => {
    const { status, events } = await runAudit({ url: `${FIXTURE_ORIGIN}/` }, "not_enough_info");
    expect(status).toBe("completed");
    const audit = finalAudit(events);
    expect(audit.opportunities.length).toBeGreaterThanOrEqual(5);
    expect(audit.verification?.status).toBe("unverified");
    expect(
      audit.opportunities.every((opportunity) =>
        opportunity.evidence.every((entry) => entry.support === "weak"),
      ),
    ).toBe(true);
    const done = events.find(
      (event) => event.type === "step.completed" && event.stepId === "critic",
    );
    expect(done).toMatchObject({
      payload: { outcome: "succeeded", critic: { citationAccuracy: 0, removed: 0 } },
    });
  });

  it("delivers the draft marked unverified instead of failing when nothing survives the critic", async () => {
    const { status, events } = await runAudit({ url: `${FIXTURE_ORIGIN}/` }, "contradicted");
    expect(status).toBe("completed");
    const audit = finalAudit(events);
    expect(audit.verification).toMatchObject({ status: "unverified" });
    expect(audit.opportunities.length).toBeGreaterThan(0);
    expect(
      audit.opportunities.every((opportunity) => opportunity.verification === "unverified"),
    ).toBe(true);
    const done = events.find(
      (event) => event.type === "step.completed" && event.stepId === "critic",
    );
    expect(done).toMatchObject({ payload: { critic: { citationAccuracy: 0 } } });
  });

  it("backfills verified reserve candidates when the critic drops picked opportunities (gate run, wikimedia-foundation 2026-11-25)", async () => {
    const { status, events } = await runAudit({ url: `${FIXTURE_ORIGIN}/` }, undefined, {
      editorPicks: 5,
      contradict: /^opp-[12]\./,
    });
    expect(status).toBe("completed");
    const audit = finalAudit(events);
    expect(audit.opportunities.length).toBeGreaterThanOrEqual(5);
    expect(audit.shortfall).toBeUndefined();
    expect(audit.opportunities.map((opportunity) => opportunity.id)).toEqual(
      audit.opportunities.map((_, index) => `opp-${index + 1}`),
    );
    const said = events.flatMap((event) =>
      event.type === "agent.message" && event.stepId === "critic" ? [event.payload.text] : [],
    );
    expect(said.join("\n")).toMatch(/Backfilled 2 verified reserve candidates/);
  });

  it("says explicitly when the evidence supports fewer than five opportunities", async () => {
    const { status, events } = await runAudit({ url: `${FIXTURE_ORIGIN}/` }, undefined, {
      editorPicks: 5,
      contradict: /^(opp-[123]|reserve-\d+)\./,
    });
    expect(status).toBe("completed");
    const audit = finalAudit(events);
    expect(audit.opportunities).toHaveLength(2);
    expect(audit.shortfall).toMatchObject({ found: 2, minimum: 5 });
    expect(audit.summary).toMatch(/Insufficient public evidence/);
  });

  it("rejects invalid input", async () => {
    const { status, events } = await runAudit({ url: "ftp://acme.example" });
    expect(status).toBe("failed");
    expect(foldRun(events).error?.code).toBe("invalid_input");
  });
});
