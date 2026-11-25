import type { RunEvent } from "@delegate/runtime";
import { describe, expect, it } from "vitest";

import { buildAgentDeliverables, evalRows, passRateLabel } from "./build-agent";

const assistantId = "6f1c3a52-3c5e-4d3c-9d55-0d2f3c1e9b10";

const assistantContent = {
  id: assistantId,
  name: "Billing helper",
  url: "https://acme.com/",
  collection: `build-agent:${assistantId}`,
  goal: "Answer billing questions",
  systemPrompt: "You answer from sources.",
  persona: "Calm.",
  scope: { covers: ["Billing"], excludes: ["Legal advice"] },
  refusalPolicy: "I can only answer from acme.com.",
  starterQuestions: ["How do refunds work?"],
  corpusStats: {
    pages: 12,
    chunks: 140,
    flaggedChunks: 1,
    embeddedChunks: 140,
    tokens: 40_000,
    bytes: 200_000,
    skippedPages: 2,
  },
  retrieval: { mode: "hybrid", rerank: true },
  modelChain: { answer: [{ provider: "p", model: "m" }], rerank: [] },
  prompts: { answer: 1 },
  status: "ready",
};

let seq = 0;
function artifact(kind: string, content: unknown, id = kind, type = "artifact.created"): RunEvent {
  seq += 1;
  return {
    runId: "r",
    seq,
    at: "2026-11-24T10:00:00.000Z",
    type,
    payload: { artifactId: id, kind, title: kind, version: seq, content },
  } as RunEvent;
}

describe("buildAgentDeliverables", () => {
  it("returns the latest valid content per build-agent artifact kind", () => {
    const evals = {
      assistantId,
      cases: [
        {
          id: "c1",
          question: "Refunds?",
          answerable: true,
          expectedAnswer: "30 days",
          expectedCitations: [],
        },
        {
          id: "c2",
          question: "CEO salary?",
          answerable: false,
          expectedAnswer: "",
          expectedCitations: [],
        },
      ],
      results: [
        {
          caseId: "c1",
          answer: "Within 30 days [1].",
          refused: false,
          citations: [{ chunkId: "k", url: "https://acme.com/refunds" }],
          verdict: "pass" as const,
          reason: "cited",
          durationMs: 10,
        },
      ],
      passRate: 0.5,
      passed: 1,
      total: 2,
    };
    const events = [
      artifact("assistant", { ...assistantContent, status: "draft" }, "a"),
      artifact("assistant-evals", evals, "e"),
      artifact("assistant", assistantContent, "a", "artifact.updated"),
      artifact("gaps-report", { not: "valid" }, "g"),
    ];
    const result = buildAgentDeliverables(events);
    expect(result.assistant?.status).toBe("ready");
    expect(result.evals?.passRate).toBe(0.5);
    expect(result.gaps).toBeNull();
    expect(result.invalid).toEqual(["gaps-report"]);
    const rows = evalRows(result.evals ?? evals);
    expect(rows.map((row) => [row.question, row.verdict])).toEqual([
      ["Refunds?", "pass"],
      ["CEO salary?", "pending"],
    ]);
  });

  it("formats pass rates honestly", () => {
    expect(passRateLabel(0.857)).toBe("86%");
    expect(passRateLabel(null)).toBe("n/a");
    expect(passRateLabel(undefined)).toBe("n/a");
  });
});
