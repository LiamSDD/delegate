import {
  AUDIT_FORMULA,
  AutomationAuditSchema,
  defaultGoalPlan,
  type AssistantArtifact,
  type AutomationAudit,
  type GoalBrief,
  type RunEventDraft,
} from "@delegate/runtime";
import { type RunMissionOptions, type RunMissionResult } from "@delegate/runtime/server";

import { type AuditCase } from "../datasets/audit";
import { type BuildCase } from "../datasets/build";
import { type CustomGoalCase } from "../datasets/custom-goal";
import { type AnswerRequest, type QuestionAnswer } from "../missions/adapter";

export const FIXTURE_AT = "2026-11-25T10:00:00.000Z";
export const FIXTURE_ASSISTANT_ID = "8a1f0c5e-6d2b-4c3a-9e7f-1b2c3d4e5f60";

type Draft = Omit<RunEventDraft, "runId">;

function usage(stepId: string): Draft {
  return {
    type: "usage.updated",
    stepId,
    payload: {
      inputTokens: 2_000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costMicroUsd: 0,
      provider: "fixture",
      model: "scripted",
    },
  };
}

function created(missionId: string, input: Record<string, unknown>): Draft {
  return {
    type: "run.created",
    payload: {
      workspaceId: "eval",
      missionId,
      input,
      actor: { type: "system", id: "fixture" },
      budget: { maxTokens: 300_000, maxMicroUsd: 0 },
    },
  };
}

function artifact(kind: string, content: unknown, artifactId = `${kind}_1`): Draft {
  return {
    type: "artifact.created",
    stepId: "deliver",
    payload: { artifactId, kind, title: kind, version: 1, content },
  };
}

export function fixtureAudit(evalCase: AuditCase): AutomationAudit {
  const host = new URL(evalCase.input.url);
  const workflows = evalCase.hints.workflows;
  const departments = evalCase.hints.departments;
  const opportunities = Array.from({ length: 5 }, (_, index) => {
    const workflow = workflows[index % workflows.length];
    const department = departments[index % departments.length];
    return {
      id: `opp-${index + 1}`,
      title: `${workflow?.description ?? "Workflow"} triage`,
      department: department?.name ?? "Operations",
      workflow: `${workflow?.description ?? "Workflow"} handled by hand today.`,
      automation: `Draft and route ${workflow?.terms[0] ?? "requests"} with a reviewed agent.`,
      frequencyPerMonth: 400 - index * 50,
      minutesPerTask: 10,
      peopleInvolved: 3,
      adoptionRate: 0.5,
      hourlyCostEur: 40,
      difficulty: "medium" as const,
      risks: ["Needs a human review step"],
      integrations: ["ticketing"],
      firstStep: "Export one month of requests and label them.",
      evidence: [{ text: workflow?.evidence ?? "Documented on the site.", citations: ["S1"] }],
      assumptions: ["Volumes are estimates"],
    };
  });
  return AutomationAuditSchema.parse({
    company: evalCase.company.name,
    summary: `Fixture audit for ${evalCase.company.name}.`,
    opportunities,
    sources: [
      {
        sourceId: "S1",
        url: `${host.origin}/`,
        title: evalCase.company.name,
        fetchedAt: FIXTURE_AT,
        kind: "company_site",
      },
    ],
    formula: AUDIT_FORMULA,
  });
}

export function fixtureAssistant(evalCase: BuildCase): AssistantArtifact {
  return {
    id: FIXTURE_ASSISTANT_ID,
    name: `${evalCase.site.name} assistant`,
    url: evalCase.input.url,
    collection: `fixture-${evalCase.id}`,
    goal: evalCase.input.goal,
    systemPrompt: "Answer only from the indexed pages.",
    persona: "Concise and factual.",
    scope: { covers: ["The organisation's public pages"], excludes: ["Anything else"] },
    refusalPolicy: "Decline when the pages do not answer.",
    starterQuestions: [evalCase.questions[0]?.question ?? "What do you do?"],
    corpusStats: {
      pages: 12,
      chunks: 80,
      flaggedChunks: 0,
      embeddedChunks: 0,
      tokens: 20_000,
      bytes: 90_000,
      skippedPages: 0,
    },
    retrieval: { mode: "full-text", rerank: false },
    modelChain: { answer: [{ provider: "fixture", model: "scripted" }], rerank: [] },
    prompts: { "assistant.answer": 1 },
    status: "ready",
  };
}

export function fixtureGoalBrief(evalCase: CustomGoalCase): GoalBrief {
  const target = evalCase.expected.target;
  const company =
    target.kind === "domain"
      ? { name: target.host, url: `https://${target.host}/`, resolvedBy: "domain" as const }
      : target.kind === "brand"
        ? {
            name: target.name,
            url: `https://www.${target.name.toLowerCase()}.com/`,
            resolvedBy: "wikidata" as const,
            entity: "Q1",
          }
        : null;
  const basis = { text: "The source describes the current process.", citations: ["S1"] };
  return {
    missionId: "custom-goal",
    status: "complete",
    goal: evalCase.input.goal,
    objective: evalCase.input.goal,
    company,
    workstreams: [{ name: "Main", findings: [basis] }],
    actions: Array.from({ length: Math.max(3, evalCase.expected.minActions) }, (_, index) => ({
      rank: index + 1,
      score: 1,
      title: `Action ${index + 1}`,
      owner: "Operations lead",
      effort: "medium" as const,
      impact: "medium" as const,
      mission: null,
      basis,
    })),
    risks: [],
    openQuestions: [],
    sources: [
      {
        sourceId: "S1",
        url: company?.url ?? "https://en.wikipedia.org/wiki/Software_testing",
        title: "Source",
        kind: company === null ? "wikipedia" : "company_site",
        fetchedAt: FIXTURE_AT,
        quotes: ["current process"],
      },
    ],
    sourceMix: {
      company_site: company === null ? 0 : 1,
      wikipedia: company === null ? 1 : 0,
      wikidata: 0,
      github: 0,
      feed: 0,
      connector: 0,
    },
    rankFormula: "score = impact ÷ effort",
    generatedAt: FIXTURE_AT,
    promptVersions: [],
  };
}

export function auditFixtureDrafts(
  evalCase: AuditCase,
  content: unknown = fixtureAudit(evalCase),
): Draft[] {
  return [
    created("automation-audit", evalCase.input),
    usage("analyse"),
    artifact("automation-audit", content),
    { type: "run.completed", payload: { summary: "audit" } },
  ];
}

export function buildFixtureDrafts(
  evalCase: BuildCase,
  content: unknown = fixtureAssistant(evalCase),
): Draft[] {
  return [
    created("build-agent", evalCase.input),
    usage("design"),
    artifact("assistant", content),
    { type: "run.completed", payload: { summary: "assistant ready" } },
  ];
}

export function goalFixtureDrafts(
  evalCase: CustomGoalCase,
  content: unknown = fixtureGoalBrief(evalCase),
): Draft[] {
  return [
    created("custom-goal", evalCase.input),
    {
      type: "plan.proposed",
      payload: {
        version: 1,
        steps: defaultGoalPlan(evalCase.expected.target.kind !== "none"),
        source: "default",
      },
    },
    usage("synthesise"),
    artifact("goal-brief", content),
    { type: "run.completed", payload: { summary: "goal brief" } },
  ];
}

export function scriptedRunMission(
  drafts: (options: RunMissionOptions) => Draft[] | Promise<Draft[]>,
): (options: RunMissionOptions) => Promise<RunMissionResult> {
  return async (options) => {
    const list = await drafts(options);
    for (const draft of list.slice(1))
      await options.emit({ ...draft, runId: options.runId } as RunEventDraft);
    return {
      status: list.some((draft) => draft.type === "run.completed") ? "completed" : "failed",
    };
  };
}

export type AnswerOverride = Omit<Partial<QuestionAnswer>, "refusal"> & { refusal?: string | null };

export function fixtureAnswers(
  cases: readonly BuildCase[],
  overrides: Partial<Record<string, AnswerOverride>> = {},
): (request: AnswerRequest) => Promise<QuestionAnswer> {
  const inScope = new Map(cases.flatMap((c) => c.questions.map((q) => [q.question, q] as const)));
  return (request) => {
    const question = inScope.get(request.question);
    const base: QuestionAnswer =
      question === undefined
        ? {
            question: request.question,
            answer: "",
            refused: true,
            refusal: "not_in_sources",
            citations: [],
          }
        : {
            question: request.question,
            answer: question.expectedAnswer,
            refused: false,
            citations: [{ url: question.sourceUrl, quote: question.expectedAnswer.slice(0, 120) }],
            servedBy: { provider: "fixture", model: "scripted" },
          };
    const { refusal, ...override } = overrides[request.question] ?? {};
    const merged: QuestionAnswer = { ...base, ...override };
    if (refusal === null) delete merged.refusal;
    else if (refusal !== undefined) merged.refusal = refusal;
    return Promise.resolve(merged);
  };
}
