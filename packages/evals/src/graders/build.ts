import {
  ASSISTANT_EVALS_KIND,
  ASSISTANT_KIND,
  AssistantArtifactSchema,
  AssistantEvalsSchema,
  type RunEvent,
} from "@delegate/runtime";
import { z } from "zod";

import { onSite, type BuildCase } from "../datasets/build";
import { runCompletedCheck, type MissionGrade } from "../missions/adapter";
import {
  budgetChecks,
  hardFailuresOf,
  hygieneChecks,
  lastArtifactContent,
  runMetrics,
  runOutcome,
  servingFrom,
  type BudgetTargets,
  type GradedCheck,
} from "./run-metrics";
import { normaliseText } from "./xray";

export const BUILD_TARGETS = { minAnswerAccuracy: 0.6 } as const;
export const UNAVAILABLE_REFUSALS: readonly string[] = [
  "rate_limited",
  "unavailable",
  "invalid_request",
];

export const QaAnswerSchema = z.strictObject({
  questionId: z.string().min(1),
  scope: z.enum(["in_scope", "out_of_scope"]),
  question: z.string().min(1),
  answer: z.string(),
  refused: z.boolean(),
  refusal: z.string().optional(),
  citations: z
    .array(
      z.strictObject({
        url: z.string().min(1),
        title: z.string().optional(),
        quote: z.string().optional(),
      }),
    )
    .max(10),
  servedBy: z.strictObject({ provider: z.string(), model: z.string() }).optional(),
  latencyMs: z.number().int().nonnegative(),
  attempts: z.number().int().positive(),
});
export type QaAnswer = z.infer<typeof QaAnswerSchema>;

export const QaRecordSchema = z.strictObject({
  assistantId: z.string().nullable(),
  answers: z.array(QaAnswerSchema),
  note: z.string().optional(),
});
export type QaRecord = z.infer<typeof QaRecordSchema>;

export function finalAssistant(events: readonly RunEvent[]): unknown {
  return lastArtifactContent(events, ASSISTANT_KIND);
}

export function answerMatches(answer: string, mustInclude: readonly string[]): boolean {
  const text = normaliseText(answer);
  return mustInclude.every((term) => text.includes(normaliseText(term)));
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

export function gradeBuild(input: {
  evalCase: BuildCase;
  events: readonly RunEvent[];
  targets: BudgetTargets;
  extras?: QaRecord;
}): MissionGrade {
  const { evalCase, events } = input;
  const { outcome, failureCode } = runOutcome(events);
  const metrics = runMetrics(events);
  const raw = finalAssistant(events);
  const assistant = AssistantArtifactSchema.safeParse(raw);
  const qa = input.extras;
  const checks: GradedCheck[] = [
    runCompletedCheck(outcome, failureCode),
    {
      kind: "schema_valid",
      severity: "hard",
      passed: assistant.success && assistant.data.status === "ready",
      ...(assistant.success
        ? assistant.data.status === "ready"
          ? {}
          : { detail: "assistant is still a draft" }
        : { detail: raw === undefined ? "no assistant artifact" : "assistant artifact invalid" }),
    },
  ];
  const available = (qa?.answers ?? []).filter(
    (a) => a.refusal === undefined || !UNAVAILABLE_REFUSALS.includes(a.refusal),
  );
  const expected = evalCase.questions.length + evalCase.outOfScope.length;
  checks.push({
    kind: "qa_complete",
    severity: "soft",
    passed: available.length === expected,
    detail: `${available.length}/${expected} questions answered or refused by the assistant${qa?.note === undefined ? "" : `; ${qa.note}`}`,
  });
  const byId = new Map(evalCase.questions.map((q) => [q.id, q]));
  const inScope = available.filter((a) => a.scope === "in_scope");
  const outOfScope = available.filter((a) => a.scope === "out_of_scope");
  const correct = inScope.filter((a) => {
    const question = byId.get(a.questionId);
    return question !== undefined && !a.refused && answerMatches(a.answer, question.mustInclude);
  });
  const falseRefusals = inScope.filter((a) => a.refused);
  const leaked = outOfScope.filter((a) => !a.refused);
  const answered = available.filter((a) => !a.refused);
  const uncited = answered.filter((a) => a.citations.length === 0);
  const offSite = answered.flatMap((a) =>
    a.citations.filter((c) => !onSite(c.url, evalCase.input.url)).map((c) => c.url),
  );
  const hasQa = available.length > 0;
  checks.push(
    {
      kind: "out_of_scope_refused",
      severity: "hard",
      passed: hasQa && leaked.length === 0 && outOfScope.length > 0,
      detail: hasQa
        ? `${outOfScope.length - leaked.length}/${outOfScope.length} out-of-scope questions refused${leaked.length === 0 ? "" : `; answered: ${leaked.map((a) => a.questionId).join(", ")}`}`
        : "no answers recorded",
    },
    {
      kind: "answers_cited",
      severity: "hard",
      passed: hasQa && uncited.length === 0,
      detail: hasQa
        ? `${answered.length - uncited.length}/${answered.length} answers cite a crawled page`
        : "no answers recorded",
    },
    {
      kind: "citations_on_site",
      severity: "hard",
      passed: hasQa && offSite.length === 0,
      detail:
        offSite.length === 0
          ? "all citations on the crawled site"
          : `off-site: ${offSite.slice(0, 3).join(", ")}`,
    },
  );
  const accuracy = rate(correct.length, inScope.length);
  checks.push({
    kind: "answer_accuracy",
    severity: "soft",
    passed: inScope.length > 0 && accuracy >= BUILD_TARGETS.minAnswerAccuracy,
    detail: `${correct.length}/${inScope.length} answers contain every expected term (min ${BUILD_TARGETS.minAnswerAccuracy * 100}%)`,
  });
  const selfEval = AssistantEvalsSchema.safeParse(
    lastArtifactContent(events, ASSISTANT_EVALS_KIND),
  );
  checks.push({
    kind: "self_eval_present",
    severity: "soft",
    passed: selfEval.success && selfEval.data.total > 0,
    detail: selfEval.success
      ? `${selfEval.data.passed}/${selfEval.data.total} self-generated cases passed`
      : "no assistant-evals artifact",
  });
  checks.push(...budgetChecks(metrics, input.targets), ...hygieneChecks(events, metrics));
  const missionMetrics: Record<string, number> = {
    answerAccuracy: accuracy,
    falseRefusalRate: rate(falseRefusals.length, inScope.length),
    outOfScopeRefusalRate: rate(outOfScope.length - leaked.length, outOfScope.length),
    citedAnswerRate: rate(answered.length - uncited.length, answered.length),
    questionsAvailable: available.length,
  };
  if (assistant.success) {
    missionMetrics.pages = assistant.data.corpusStats.pages;
    missionMetrics.chunks = assistant.data.corpusStats.chunks;
  }
  if (selfEval.success && selfEval.data.passRate !== null)
    missionMetrics.selfEvalPassRate = selfEval.data.passRate;
  const onSiteCheck = checks.find((c) => c.kind === "citations_on_site");
  const citedCheck = checks.find((c) => c.kind === "answers_cited");
  return {
    outcome,
    ...(failureCode === undefined ? {} : { failureCode }),
    checks,
    hardFailures: hardFailuresOf(outcome, checks),
    metrics,
    missionMetrics,
    serving: servingFrom(events),
    deliverable: raw,
    citationsVerified:
      outcome === "errored" || !hasQa
        ? null
        : onSiteCheck?.passed === true && citedCheck?.passed === true,
  };
}
