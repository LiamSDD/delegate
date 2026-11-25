import { describe, expect, it } from "vitest";

import {
  applyAnswerEvent,
  type AssistantMessage,
  createSseParser,
  historyFor,
  splitAnswer,
} from "./chat";

const fresh = (): AssistantMessage => ({
  id: "a1",
  role: "assistant",
  text: "",
  citations: [],
  refusal: null,
  status: "streaming",
  error: null,
});

describe("createSseParser", () => {
  it("reassembles frames split across chunks and ignores comments", () => {
    const parse = createSseParser();
    expect(parse(': ping\n\nevent: delta\ndata: {"type":"del')).toEqual([]);
    expect(parse('ta","text":"Hi"}\n\nevent: done\n')).toEqual([
      { event: "delta", data: '{"type":"delta","text":"Hi"}' },
    ]);
    expect(parse('data: {"type":"done"}\n\n')).toEqual([
      { event: "done", data: '{"type":"done"}' },
    ]);
  });
});

describe("applyAnswerEvent", () => {
  it("streams deltas, records citations once and finishes", () => {
    let message = fresh();
    message = applyAnswerEvent(message, { type: "delta", text: "Refunds take 30 days " });
    message = applyAnswerEvent(message, { type: "delta", text: "[1]." });
    const citation = {
      type: "citation" as const,
      index: 1,
      chunkId: "k1",
      url: "https://acme.com/refunds",
      title: "Refunds",
      quote: "within 30 days",
    };
    message = applyAnswerEvent(message, citation);
    message = applyAnswerEvent(message, citation);
    expect(message.text).toBe("Refunds take 30 days [1].");
    expect(message.citations).toHaveLength(1);
    message = applyAnswerEvent(message, {
      type: "done",
      answer: "Refunds take 30 days [1].",
      citations: [{ ...citation, index: 1 }],
      grounded: true,
      refused: false,
      usage: { inputTokens: 1, outputTokens: 1 },
      retrieval: { mode: "hybrid", candidates: 4, used: 2, reranked: true },
      durationMs: 900,
    });
    expect(message.status).toBe("done");
    expect(message.durationMs).toBe(900);
  });

  it("keeps a refusal and its reason", () => {
    const message = applyAnswerEvent(fresh(), {
      type: "refusal",
      reason: "not_in_sources",
      message: "I can only answer from acme.com.",
    });
    expect(message.refusal).toEqual({
      reason: "not_in_sources",
      message: "I can only answer from acme.com.",
    });
  });
});

describe("splitAnswer", () => {
  it("turns [n] and [n, m] markers into citation segments and leaves unknown ones as text", () => {
    const citations = [
      { index: 1, chunkId: "a", url: "https://a" },
      { index: 2, chunkId: "b", url: "https://b" },
    ];
    expect(splitAnswer("A [1]. B [1, 2]. C [9].", citations)).toEqual([
      { kind: "text", text: "A " },
      { kind: "cite", citation: citations[0] },
      { kind: "text", text: ". B " },
      { kind: "cite", citation: citations[0] },
      { kind: "cite", citation: citations[1] },
      { kind: "text", text: ". C [9]." },
    ]);
  });
});

describe("historyFor", () => {
  it("sends only completed, non-refused turns, newest last, capped", () => {
    const done = (id: string, text: string): AssistantMessage => ({
      ...fresh(),
      id,
      text,
      status: "done",
    });
    const history = historyFor(
      [
        { id: "u1", role: "user", text: "q1" },
        done("a1", "answer one"),
        { id: "u2", role: "user", text: "q2" },
        { ...done("a2", ""), refusal: { reason: "not_in_sources", message: "no" } },
        { id: "u3", role: "user", text: "q3" },
        { ...fresh(), id: "a3" },
      ],
      2,
    );
    expect(history).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "answer one" },
    ]);
  });
});
