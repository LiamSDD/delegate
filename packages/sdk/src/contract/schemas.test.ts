import { describe, expect, it } from "vitest";

import { ErrorEnvelopeSchema } from "./errors";
import {
  ChatRequestSchema,
  CreateRunRequestSchema,
  IDEMPOTENCY_KEY_PATTERN,
  ListRunEventsQuerySchema,
  ListRunsQuerySchema,
  MISSION_IDS,
  MISSION_INPUT_RULES,
  RUN_INPUT_FIELDS,
  type RunInputField,
  RunSchema,
} from "./schemas";

const SAMPLE: Record<RunInputField, string> = {
  url: "https://acme.example",
  goal: "Answer pricing questions",
  focus: "pricing",
  department: "support",
  name: "Acme helper",
  opportunityId: "opp-1",
  ref: "main",
};

function inputWith(fields: readonly RunInputField[]) {
  return Object.fromEntries(fields.map((field) => [field, SAMPLE[field]]));
}

describe("CreateRunRequestSchema", () => {
  it("accepts every mission with exactly its required fields", () => {
    for (const missionId of MISSION_IDS) {
      const parsed = CreateRunRequestSchema.safeParse({
        missionId,
        input: inputWith(MISSION_INPUT_RULES[missionId].required),
      });
      expect(parsed.success, missionId).toBe(true);
    }
  });

  it("accepts every optional field of a mission and rejects every other field", () => {
    for (const missionId of MISSION_IDS) {
      const rule = MISSION_INPUT_RULES[missionId];
      for (const field of RUN_INPUT_FIELDS) {
        if (rule.required.includes(field)) continue;
        const parsed = CreateRunRequestSchema.safeParse({
          missionId,
          input: inputWith([...rule.required, field]),
        });
        expect(parsed.success, `${missionId} + ${field}`).toBe(rule.optional.includes(field));
      }
    }
  });

  it("names the missing field", () => {
    const parsed = CreateRunRequestSchema.safeParse({ missionId: "build-agent", input: {} });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path.join("."))).toEqual([
      "input.url",
      "input.goal",
    ]);
  });

  it("takes parentRunId for build-agent only", () => {
    const parentRunId = "7d1d4f3e-2b8e-4c41-9e0f-3c2b1a0d9e8f";
    for (const missionId of MISSION_IDS) {
      const parsed = CreateRunRequestSchema.safeParse({
        missionId,
        input: inputWith(MISSION_INPUT_RULES[missionId].required),
        parentRunId,
      });
      expect(parsed.success, missionId).toBe(missionId === "build-agent");
    }
  });

  it("needs a goal of at least three characters for goal-led missions", () => {
    for (const missionId of ["custom-goal", "autopilot"] as const) {
      expect(CreateRunRequestSchema.safeParse({ missionId, input: { goal: "ab" } }).success).toBe(
        false,
      );
      expect(CreateRunRequestSchema.safeParse({ missionId, input: { goal: "abc" } }).success).toBe(
        true,
      );
    }
  });

  it("rejects unknown missions, unknown keys and path-like refs", () => {
    expect(
      CreateRunRequestSchema.safeParse({ missionId: "ship-a-pr", input: { url: SAMPLE.url } })
        .success,
    ).toBe(false);
    expect(
      CreateRunRequestSchema.safeParse({
        missionId: "company-xray",
        input: { url: SAMPLE.url, fromAuditRunId: "x" },
      }).success,
    ).toBe(false);
    expect(
      CreateRunRequestSchema.safeParse({
        missionId: "repo-xray",
        input: { url: SAMPLE.url, ref: "../../etc/passwd" },
      }).success,
    ).toBe(false);
  });
});

describe("query schemas", () => {
  it("coerce numbers from the query string and fill defaults", () => {
    expect(ListRunsQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(ListRunsQuerySchema.parse({ limit: "5", status: "completed" })).toEqual({
      limit: 5,
      status: "completed",
    });
    expect(ListRunEventsQuerySchema.parse({ after: "12" })).toEqual({ after: 12, limit: 200 });
  });

  it("reject out-of-range values and unknown parameters", () => {
    expect(ListRunsQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(ListRunsQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
    expect(ListRunsQuerySchema.safeParse({ limit: "ten" }).success).toBe(false);
    expect(ListRunsQuerySchema.safeParse({ page: "2" }).success).toBe(false);
    expect(ListRunEventsQuerySchema.safeParse({ after: "-1" }).success).toBe(false);
    expect(ListRunEventsQuerySchema.safeParse({ limit: "501" }).success).toBe(false);
  });
});

describe("response schemas", () => {
  it("strip fields that are not part of the contract", () => {
    const run = RunSchema.parse({
      id: "7d1d4f3e-2b8e-4c41-9e0f-3c2b1a0d9e8f",
      mission: "company-xray",
      status: "running",
      terminal: false,
      createdAt: "2026-11-25T10:00:00.000Z",
      finishedAt: null,
      totals: { inputTokens: 1, outputTokens: 2, costMicroUsd: 0, toolCalls: 3 },
      pendingPlan: null,
      pendingApprovals: [],
      steps: [],
      artifacts: [],
      deliverable: null,
      summary: null,
      error: null,
      target: "acme.example",
      execution: "live",
      startedAt: null,
      webUrl: "https://delegate.example/runs/7d1d4f3e-2b8e-4c41-9e0f-3c2b1a0d9e8f",
      leaseOwner: "worker-1",
    });
    expect(run).not.toHaveProperty("leaseOwner");
  });

  it("keep the error envelope closed to unknown codes", () => {
    expect(
      ErrorEnvelopeSchema.safeParse({
        error: { code: "not_found", message: "No run", requestId: "req_1" },
      }).success,
    ).toBe(true);
    expect(
      ErrorEnvelopeSchema.safeParse({
        error: { code: "teapot", message: "No", requestId: "req_1" },
      }).success,
    ).toBe(false);
  });
});

describe("limits", () => {
  it("bounds chat questions and history", () => {
    expect(ChatRequestSchema.parse({ question: "  What does it cost?  " })).toEqual({
      question: "What does it cost?",
      history: [],
    });
    expect(ChatRequestSchema.safeParse({ question: "x".repeat(1_001) }).success).toBe(false);
    expect(
      ChatRequestSchema.safeParse({
        question: "ok",
        history: Array.from({ length: 13 }, () => ({ role: "user", content: "hi" })),
      }).success,
    ).toBe(false);
  });

  it("accepts printable ASCII idempotency keys up to 255 characters", () => {
    expect(IDEMPOTENCY_KEY_PATTERN.test("7d1d4f3e-2b8e-4c41-9e0f-3c2b1a0d9e8f")).toBe(true);
    expect(IDEMPOTENCY_KEY_PATTERN.test("k".repeat(255))).toBe(true);
    expect(IDEMPOTENCY_KEY_PATTERN.test("k".repeat(256))).toBe(false);
    expect(IDEMPOTENCY_KEY_PATTERN.test("")).toBe(false);
    expect(IDEMPOTENCY_KEY_PATTERN.test("has space")).toBe(false);
    expect(IDEMPOTENCY_KEY_PATTERN.test("line\nbreak")).toBe(false);
    expect(IDEMPOTENCY_KEY_PATTERN.test("ünïcode")).toBe(false);
  });
});
