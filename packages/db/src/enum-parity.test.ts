import { PromptVersionsSchema as EvalPromptVersionsSchema } from "@delegate/evals";
import { DATA_CLASSIFICATIONS, DECISIONS } from "@delegate/policy";
import {
  type BudgetLimits,
  type RunEventOf,
  type RunStatus,
  PolicyDecisionKindSchema,
  UsageSchema,
} from "@delegate/runtime";
import { describe, expect, it } from "vitest";

import { promptVersionsSchema, runBudgetSchema, runTotalsSchema } from "./run-json";
import { approvalStatus, auditDecision, documentClassification, runStatus } from "./schema";

const sorted = (values: readonly string[]) => [...values].sort();

const RUNTIME_RUN_STATUSES = {
  planning: true,
  awaiting_plan_approval: true,
  running: true,
  awaiting_approval: true,
  completed: true,
  failed: true,
} as const satisfies Record<RunStatus, true>;

const RUNTIME_APPROVAL_RESOLUTIONS = {
  approved: true,
  rejected: true,
} as const satisfies Record<RunEventOf<"approval.resolved">["payload"]["resolution"], true>;

const RUNTIME_BUDGET_FIELDS = {
  maxTokens: true,
  maxMicroUsd: true,
} as const satisfies Record<keyof BudgetLimits, true>;

describe("database enums match the packages that produce their values", () => {
  it("run_status is exactly the runtime RunStatus, so runs.status can be rebuilt from the event fold", () => {
    expect(sorted(runStatus.enumValues)).toEqual(sorted(Object.keys(RUNTIME_RUN_STATUSES)));
  });

  it("approval_status is pending plus the runtime resolutions plus expired", () => {
    expect(sorted(approvalStatus.enumValues)).toEqual(
      sorted(["pending", "expired", ...Object.keys(RUNTIME_APPROVAL_RESOLUTIONS)]),
    );
  });

  it("document_classification is exactly the policy engine's data classifications", () => {
    expect(sorted(documentClassification.enumValues)).toEqual(sorted(DATA_CLASSIFICATIONS));
  });

  it("audit_decision covers every policy and runtime decision, plus n/a for non-policy entries", () => {
    expect(sorted(auditDecision.enumValues)).toEqual(sorted([...DECISIONS, "n/a"]));
    expect(sorted(PolicyDecisionKindSchema.options)).toEqual(sorted(DECISIONS));
  });
});

describe("run json columns match the runtime and eval contracts", () => {
  it("budget uses the runtime BudgetLimits field names", () => {
    expect(sorted(runBudgetSchema.keyof().options)).toEqual(
      sorted(Object.keys(RUNTIME_BUDGET_FIELDS)),
    );
    expect(runBudgetSchema.parse({ maxTokens: 1000, maxMicroUsd: 0 })).toEqual({
      maxTokens: 1000,
      maxMicroUsd: 0,
    });
    expect(runBudgetSchema.safeParse({ maxCostMicroUsd: 1 }).success).toBe(false);
  });

  it("totals are the token and cost fields of the runtime usage record", () => {
    const usageFields = UsageSchema.keyof().options as readonly string[];
    for (const field of runTotalsSchema.keyof().options) {
      expect(usageFields).toContain(field);
    }
  });

  it.each([
    [{ xray: 3, "planner-system": 1 }],
    [{}],
    [{ xray: "v1" }],
    [{ xray: 0 }],
    [{ xray: 1.5 }],
    [{ "Not A Slug": 1 }],
  ])("prompt versions accept and reject %j exactly as the eval harness does", (value) => {
    expect(promptVersionsSchema.safeParse(value).success).toBe(
      EvalPromptVersionsSchema.safeParse(value).success,
    );
  });
});
