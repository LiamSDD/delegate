import { describe, expect, it } from "vitest";

import type { AnswerEvent } from "@/lib/m3-contract";

import { type ChatDeps, handleAssistantChat, PUBLIC_QUESTION_MAX } from "./chat";
import { createRateLimiter } from "./session";

const ORIGIN = "http://localhost:3000";
const assistantId = "6f1c3a52-3c5e-4d3c-9d55-0d2f3c1e9b10";

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}/api/embed/${assistantId}/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      host: "localhost:3000",
      "x-forwarded-for": "203.0.113.9",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function deps(overrides: Partial<ChatDeps> = {}): ChatDeps & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    publicLimiter: createRateLimiter({ limit: 2, windowMs: 3_600_000 }),
    guestLimiter: createRateLimiter({ limit: 2, windowMs: 3_600_000 }),
    exists: (id) => Promise.resolve(id === assistantId),
    guest: () => Promise.resolve(null),
    answer: async function* (options): AsyncGenerator<AnswerEvent> {
      asked.push(options.question);
      await Promise.resolve();
      yield { type: "delta", text: "Yes [1]." };
      yield { type: "citation", index: 1, chunkId: "k", url: "https://acme.com/a" };
    },
    ...overrides,
  };
}

describe("public assistant chat", () => {
  it("streams answer events as SSE frames", async () => {
    const d = deps();
    const response = await handleAssistantChat(
      request({ question: "Do you ship?" }),
      assistantId,
      "public",
      d,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain('event: delta\ndata: {"type":"delta","text":"Yes [1]."}\n\n');
    expect(text).toContain("event: citation\n");
    expect(d.asked).toEqual(["Do you ship?"]);
  });

  it("caps question length, rejects unknown assistants and cross-origin posts", async () => {
    const d = deps();
    const long = await handleAssistantChat(
      request({ question: "x".repeat(PUBLIC_QUESTION_MAX + 1) }),
      assistantId,
      "public",
      d,
    );
    expect(long.status).toBe(400);
    const missing = await handleAssistantChat(
      request({ question: "hi" }),
      "00000000-0000-4000-8000-000000000000",
      "public",
      d,
    );
    expect(missing.status).toBe(404);
    const evil = await handleAssistantChat(
      request({ question: "hi" }, { origin: "https://evil.example" }),
      assistantId,
      "public",
      d,
    );
    expect(evil.status).toBe(403);
    expect(d.asked).toEqual([]);
  });

  it("rate limits questions per IP with Retry-After", async () => {
    const d = deps();
    for (let index = 0; index < 2; index += 1) {
      const ok = await handleAssistantChat(request({ question: "q" }), assistantId, "public", d);
      expect(ok.status).toBe(200);
      await ok.text();
    }
    const limited = await handleAssistantChat(request({ question: "q" }), assistantId, "public", d);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});
