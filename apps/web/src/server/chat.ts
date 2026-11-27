import { z } from "zod";

import { type AnswerEvent, type ChatTurn, ChatTurnSchema } from "@/lib/m3-contract";

import { apiError, clientIp, isSameOrigin } from "./api";
import type { RateLimiter } from "./session";
import { SSE_HEADERS } from "./sse";

export const PUBLIC_QUESTION_MAX = 500;
export const OWNER_QUESTION_MAX = 1_000;
export const CHAT_HISTORY_MAX = 12;
export const PUBLIC_QUESTIONS_PER_HOUR = 20;
export const OWNER_QUESTIONS_PER_HOUR = 60;
const MAX_CHAT_BODY_BYTES = 32 * 1024;

export type ChatMode = "owner" | "public";

export interface ChatScope {
  userId: string;
  workspaceId: string;
}

export interface AnswerOptions {
  assistantId: string;
  question: string;
  history: ChatTurn[];
  signal: AbortSignal;
  scope?: ChatScope;
}

export interface ChatDeps {
  publicLimiter: RateLimiter;
  guestLimiter: RateLimiter;
  exists: (assistantId: string) => Promise<boolean>;
  guest: (
    request: Request,
    assistantId: string,
  ) => Promise<{ key: string; scope?: ChatScope } | null>;
  answer: (options: AnswerOptions) => AsyncIterable<AnswerEvent>;
}

function bodySchema(mode: ChatMode) {
  return z.strictObject({
    question: z
      .string()
      .trim()
      .min(1)
      .max(mode === "public" ? PUBLIC_QUESTION_MAX : OWNER_QUESTION_MAX),
    history: z.array(ChatTurnSchema).max(CHAT_HISTORY_MAX).default([]),
  });
}

function retryAfter(ms: number): Record<string, string> {
  return { "Retry-After": String(Math.max(1, Math.ceil(ms / 1000))) };
}

export function formatAnswerFrame(event: AnswerEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function answerStream(
  events: AsyncIterable<AnswerEvent>,
  controller: AbortController,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = events[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(stream) {
      try {
        const next = await iterator.next();
        if (next.done === true) {
          stream.close();
          return;
        }
        stream.enqueue(encoder.encode(formatAnswerFrame(next.value)));
      } catch (error: unknown) {
        if (!controller.signal.aborted) console.error("assistant chat failed", error);
        stream.enqueue(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({ type: "error", message: "The answer stream failed." })}\n\n`,
          ),
        );
        stream.close();
      }
    },
    async cancel() {
      controller.abort(new Error("client disconnected"));
      await iterator.return?.();
    },
  });
}

export async function handleAssistantChat(
  request: Request,
  assistantId: string,
  mode: ChatMode,
  deps: ChatDeps,
): Promise<Response> {
  if (!isSameOrigin(request)) {
    return apiError(403, "forbidden_origin", "Cross-origin requests cannot ask this assistant.");
  }
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return apiError(415, "unsupported_media_type", "Send the request body as application/json.");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_CHAT_BODY_BYTES) {
    return apiError(413, "payload_too_large", "The conversation is too long.");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return apiError(400, "invalid_json", "The request body is not valid JSON.");
  }
  const parsed = bodySchema(mode).safeParse(raw);
  if (!parsed.success) {
    return apiError(400, "invalid_request", "The question is empty or too long.", {
      issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    });
  }

  let limiterKey: string;
  let limiter: RateLimiter;
  const guest = await deps.guest(request, assistantId);
  if (mode === "owner") {
    if (guest === null) return apiError(404, "not_found", "No assistant with that id.");
    limiterKey = guest.key;
    limiter = deps.guestLimiter;
  } else {
    if (guest === null && !(await deps.exists(assistantId))) {
      return apiError(404, "not_found", "No assistant with that id.");
    }
    limiterKey = `${assistantId}:${clientIp(request)}`;
    limiter = deps.publicLimiter;
  }
  const quota = limiter.take(limiterKey);
  if (!quota.ok) {
    return apiError(429, "rate_limited", "Too many questions for now. Try again later.", {
      headers: retryAfter(quota.retryAfterMs),
    });
  }

  const controller = new AbortController();
  const signal = AbortSignal.any([request.signal, controller.signal]);
  const events = deps.answer({
    assistantId,
    question: parsed.data.question,
    history: parsed.data.history,
    signal,
    ...(guest?.scope === undefined ? {} : { scope: guest.scope }),
  });
  return new Response(answerStream(events, controller), { status: 200, headers: SSE_HEADERS });
}
