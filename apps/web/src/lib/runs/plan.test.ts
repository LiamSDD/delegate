import type { PlanStep } from "@delegate/runtime";
import { describe, expect, it } from "vitest";

import {
  draftFromPlan,
  draftIssues,
  draftToSteps,
  moveStep,
  planDiffRows,
  validatePlanEdit,
} from "./plan";

function step(id: string, inputs: string[] = [], overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    id,
    role: "researcher",
    objective: `Do ${id}`,
    inputs,
    capabilities: ["fetch"],
    acceptance: ["done"],
    budgetShare: 0.25,
    ...overrides,
  };
}

const proposed = [step("a"), step("b"), step("c", ["a"]), step("d", ["b", "c"])];

describe("validatePlanEdit", () => {
  it("accepts objective edits, removals and reorders that respect dependencies", () => {
    const edited = [step("b"), step("a", [], { objective: "Read the site" }), step("c", ["a"])];
    const result = validatePlanEdit(proposed, edited);
    expect(result).toEqual({ ok: true, steps: edited });
  });

  it("rejects steps that come before their inputs", () => {
    const result = validatePlanEdit(proposed, [step("c", ["a"]), step("a")]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join()).toMatch(/c runs before its input a/);
  });

  it("rejects new steps, role changes and added capabilities", () => {
    const result = validatePlanEdit(proposed, [
      step("a", [], { role: "builder" }),
      step("b", [], { capabilities: ["fetch", "send_email"] }),
      step("z"),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const text = result.issues.join("\n");
      expect(text).toMatch(/z is not in the proposed plan/);
      expect(text).toMatch(/a cannot change role/);
      expect(text).toMatch(/b cannot add capability send_email/);
    }
  });

  it("rejects budget shares above 1, empty plans and dangling inputs", () => {
    const over = validatePlanEdit(proposed, [
      step("a", [], { budgetShare: 0.7 }),
      step("b", [], { budgetShare: 0.6 }),
    ]);
    expect(over.ok).toBe(false);
    expect(validatePlanEdit(proposed, []).ok).toBe(false);
    const dangling = validatePlanEdit(proposed, [step("c", ["a"])]);
    expect(dangling.ok).toBe(false);
  });
});

describe("plan draft editing", () => {
  it("moves a step only within its dependency constraints", () => {
    const draft = draftFromPlan(proposed);
    expect(moveStep(draft, "c", -1)?.map((entry) => entry.step.id)).toEqual(["a", "c", "b", "d"]);
    expect(moveStep(draft, "b", -1)?.map((entry) => entry.step.id)).toEqual(["b", "a", "c", "d"]);
    expect(moveStep(moveStep(draft, "c", -1) ?? [], "c", -1)).toBeNull();
    expect(moveStep(draft, "c", 1)).toBeNull();
  });

  it("reports disabled dependencies and converts enabled steps", () => {
    const draft = draftFromPlan(proposed).map((entry) =>
      entry.step.id === "a" ? { ...entry, enabled: false } : entry,
    );
    expect(draftIssues(proposed, draft).join()).toMatch(/c depends on a/);
    const ok = draftFromPlan(proposed).map((entry) =>
      entry.step.id === "d" ? { ...entry, enabled: false } : entry,
    );
    expect(draftIssues(proposed, ok)).toEqual([]);
    expect(draftToSteps(ok).map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });
});

describe("planDiffRows", () => {
  it("marks added, removed and changed steps", () => {
    const next = [step("a", [], { objective: "Changed" }), step("b"), step("e")];
    const rows = planDiffRows(proposed.slice(0, 3), next);
    expect(rows.map((row) => [row.step.id, row.change])).toEqual([
      ["a", "changed"],
      ["b", "same"],
      ["e", "added"],
      ["c", "removed"],
    ]);
    expect(rows[0]?.fields).toEqual(["objective"]);
  });
});
