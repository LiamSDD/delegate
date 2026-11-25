import { z } from "zod";

import { RunAbortedError, type RunContext } from "../../agent/context";
import { ModelStreamError } from "../../agent/model-call";
import { StructuredOutputError } from "../../agent/structured";
import { BudgetExceededError } from "../../budget";
import { type EmbeddingProvider } from "../../knowledge/embeddings";
import { type KnowledgeStore } from "../../knowledge/types";
import { type PromptFile } from "../../prompts";
import { NoModelAvailableError } from "../../router";
import { ChatTurnSchema, streamAnswer, type AnswerEvent } from "./answer";
import { type AssistantStore } from "./schema";

export const AnswerQuestionInputSchema = z.object({
  assistantId: z.uuid(),
  question: z.string().trim().min(1).max(1_000),
  history: z.array(ChatTurnSchema).max(20).default([]),
});
export type AnswerQuestionInput = z.input<typeof AnswerQuestionInputSchema>;

export type RateLimitHook = (
  assistantId: string,
) => Promise<{ allowed: boolean; retryAfterMs?: number }>;

export interface ChatDeps {
  assistants: AssistantStore;
  knowledge: KnowledgeStore;
  context: (assistantId: string) => RunContext;
  embeddings?: EmbeddingProvider | undefined;
  prompts: { answer: PromptFile; rerank: PromptFile };
  rateLimit?: RateLimitHook;
}

const EMPTY_DONE = {
  type: "done",
  answer: "",
  citations: [],
  grounded: false,
  refused: true,
  usage: { inputTokens: 0, outputTokens: 0 },
  retrieval: { mode: "full-text", candidates: 0, used: 0, reranked: false },
  durationMs: 0,
} as const satisfies AnswerEvent;

function unavailable(error: unknown): boolean {
  return (
    error instanceof NoModelAvailableError ||
    error instanceof ModelStreamError ||
    error instanceof StructuredOutputError ||
    error instanceof BudgetExceededError
  );
}

export async function* answerWithAssistant(
  deps: ChatDeps,
  raw: AnswerQuestionInput,
): AsyncGenerator<AnswerEvent> {
  const parsed = AnswerQuestionInputSchema.safeParse(raw);
  if (!parsed.success) {
    yield {
      type: "refusal",
      reason: "invalid_request",
      message: parsed.error.issues
        .map((issue) => issue.message)
        .join("; ")
        .slice(0, 300),
    };
    yield EMPTY_DONE;
    return;
  }
  const request = parsed.data;
  if (deps.rateLimit !== undefined) {
    const verdict = await deps.rateLimit(request.assistantId);
    if (!verdict.allowed) {
      yield {
        type: "refusal",
        reason: "rate_limited",
        message: "This assistant is answering too many questions right now. Try again shortly.",
        ...(verdict.retryAfterMs === undefined ? {} : { retryAfterMs: verdict.retryAfterMs }),
      };
      yield EMPTY_DONE;
      return;
    }
  }
  const record = await deps.assistants.get(request.assistantId);
  if (record === null) {
    yield { type: "refusal", reason: "invalid_request", message: "This assistant does not exist." };
    yield EMPTY_DONE;
    return;
  }
  const ctx = deps.context(request.assistantId);
  let finished = false;
  try {
    for await (const event of streamAnswer(
      {
        ctx,
        knowledge: deps.knowledge,
        embeddings: record.config.retrieval.mode === "hybrid" ? deps.embeddings : undefined,
        prompts: deps.prompts,
      },
      { assistant: record.config, question: request.question, history: request.history },
    )) {
      if (event.type === "done") finished = true;
      yield event;
    }
  } catch (error) {
    if (finished) return;
    if (error instanceof RunAbortedError) throw error;
    if (!unavailable(error)) throw error;
    yield {
      type: "refusal",
      reason: "unavailable",
      message: "Free model capacity is used up or unavailable right now. Try again in a minute.",
    };
    yield EMPTY_DONE;
  }
}
