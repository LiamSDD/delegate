import {
  AssistantArtifactSchema,
  createMemoryAssistantStore,
  type AnswerEvent,
} from "@delegate/runtime";
import { answerQuestion, createMemoryKnowledgeStore } from "@delegate/runtime/server";

import { BUILD_DATASET, loadBuildDataset, type BuildCase } from "../datasets/build";
import {
  QaRecordSchema,
  UNAVAILABLE_REFUSALS,
  finalAssistant,
  gradeBuild,
  type QaAnswer,
  type QaRecord,
} from "../graders/build";
import { rubricVerdictSchema } from "../judge/rubric-judge";
import {
  type AnswerRequest,
  type ExtrasContext,
  type MissionAdapter,
  type QuestionAnswer,
  type TrialStores,
} from "./adapter";

export const BUILD_JUDGE_CRITERIA = [
  "correctness",
  "groundedness",
  "refusalQuality",
  "concision",
] as const;
export const QA_RETRIES = 2;
export const QA_BACKOFF_MS = 30_000;

export async function answerWithRuntime(request: AnswerRequest): Promise<QuestionAnswer> {
  const events: AsyncIterable<AnswerEvent> = answerQuestion({
    assistantId: request.assistantId,
    question: request.question,
    env: request.env,
    audience: request.audience,
    ...request.stores,
  });
  let refusal: string | undefined;
  for await (const event of events) {
    if (event.type === "refusal") refusal = event.reason;
    if (event.type === "done")
      return {
        question: request.question,
        answer: event.answer,
        refused: event.refused,
        ...(refusal === undefined ? {} : { refusal }),
        citations: event.citations.map((c) => ({
          url: c.url,
          ...(c.title === undefined ? {} : { title: c.title }),
          ...(c.quote === undefined ? {} : { quote: c.quote }),
        })),
        ...(event.servedBy === undefined
          ? {}
          : { servedBy: { provider: event.servedBy.provider, model: event.servedBy.model } }),
      };
  }
  throw new Error("The answer stream ended without a done event");
}

export async function collectAnswers(
  context: ExtrasContext<BuildCase>,
  stores: TrialStores,
): Promise<QaRecord> {
  const assistant = AssistantArtifactSchema.safeParse(finalAssistant(context.events));
  if (!assistant.success)
    return { assistantId: null, answers: [], note: "no assistant was built, nothing to ask" };
  const ask = context.answer;
  if (ask === undefined)
    return { assistantId: assistant.data.id, answers: [], note: "no answer function configured" };
  const questions = [
    ...context.evalCase.questions.map((q) => ({
      id: q.id,
      question: q.question,
      scope: "in_scope" as const,
    })),
    ...context.evalCase.outOfScope.map((q) => ({
      id: q.id,
      question: q.question,
      scope: "out_of_scope" as const,
    })),
  ];
  const answers: QaAnswer[] = [];
  for (const entry of questions) {
    for (let attempt = 0; ; attempt += 1) {
      const started = context.now().getTime();
      const result = await ask({
        assistantId: assistant.data.id,
        question: entry.question,
        env: context.env,
        audience: context.audience,
        stores,
      });
      const unavailable =
        result.refusal !== undefined && UNAVAILABLE_REFUSALS.includes(result.refusal);
      if (unavailable && attempt < QA_RETRIES) {
        const wait = QA_BACKOFF_MS * 2 ** attempt;
        context.log(
          `    ${entry.id}: ${result.refusal ?? "unavailable"}, retrying in ${wait / 1000} s`,
        );
        await context.sleep(wait);
        continue;
      }
      answers.push({
        questionId: entry.id,
        scope: entry.scope,
        question: entry.question,
        answer: result.answer,
        refused: result.refused,
        ...(result.refusal === undefined ? {} : { refusal: result.refusal }),
        citations: result.citations,
        ...(result.servedBy === undefined ? {} : { servedBy: result.servedBy }),
        latencyMs: Math.max(0, context.now().getTime() - started),
        attempts: attempt + 1,
      });
      break;
    }
  }
  return { assistantId: assistant.data.id, answers };
}

export function renderBuildJudgeInput(
  evalCase: BuildCase,
  deliverable: unknown,
  qa: QaRecord | undefined,
): string {
  const assistant = AssistantArtifactSchema.parse(deliverable);
  const byId = new Map(qa?.answers.map((a) => [a.questionId, a]) ?? []);
  const lines = [
    `Site: ${evalCase.site.name} (${evalCase.input.url})`,
    `Assistant goal: ${assistant.goal}`,
    `Refusal policy: ${assistant.refusalPolicy}`,
    "",
    "## Questions",
  ];
  const show = (id: string) => {
    const answer = byId.get(id);
    if (answer === undefined) return ["Assistant: (no answer recorded)"];
    return [
      answer.refused
        ? `Assistant refused (${answer.refusal ?? "refused"}): ${answer.answer.slice(0, 600)}`
        : `Assistant: ${answer.answer.slice(0, 1_200)}`,
      ...answer.citations.map(
        (c, index) =>
          `  [${index + 1}] ${c.url}${c.quote === undefined ? "" : ` > ${c.quote.slice(0, 200)}`}`,
      ),
    ];
  };
  for (const q of evalCase.questions)
    lines.push(
      `### ${q.id} (in scope)`,
      `Q: ${q.question}`,
      `Expected: ${q.expectedAnswer}`,
      ...show(q.id),
    );
  for (const q of evalCase.outOfScope)
    lines.push(`### ${q.id} (out of scope: must be declined)`, `Q: ${q.question}`, ...show(q.id));
  return lines.join("\n");
}

export const buildMission: MissionAdapter<BuildCase, QaRecord> = {
  mission: "build",
  title: "Build-an-Agent",
  runtimeMissionId: "build-agent",
  dataset: BUILD_DATASET,
  loadCases: (path) => (path === undefined ? loadBuildDataset() : loadBuildDataset(path)),
  subject: (evalCase) => evalCase.site.name,
  input: (evalCase) => evalCase.input,
  runtimePrompts: [
    "planner",
    "designer",
    "evalgen",
    "grader",
    "gaps",
    "answer",
    "rerank",
    "critic",
    "editor",
  ],
  defaultTargets: { maxLatencyMs: 300_000, maxCostMicroUsd: 0, maxTokens: 300_000 },
  citedUrls: () => [],
  grade: (input) => gradeBuild(input),
  judge: {
    promptFile: "build-judge.v1.md",
    criteria: BUILD_JUDGE_CRITERIA,
    schema: rubricVerdictSchema(BUILD_JUDGE_CRITERIA),
    render: renderBuildJudgeInput,
    ready: (grade) =>
      grade.checks.some((c) => c.kind === "schema_valid" && c.passed) &&
      (grade.missionMetrics.questionsAvailable ?? 0) > 0,
  },
  extras: {
    file: "qa.json",
    schema: QaRecordSchema,
    stores: () => ({
      knowledge: createMemoryKnowledgeStore(),
      assistants: createMemoryAssistantStore(),
    }),
    collect: collectAnswers,
  },
};
