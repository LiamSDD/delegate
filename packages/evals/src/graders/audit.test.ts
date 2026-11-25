import { parseRunEvent, type RunEvent } from "@delegate/runtime";
import { describe, expect, it } from "vitest";

import { loadAuditDataset } from "../datasets/audit";
import { renderAuditJudgeInput } from "../missions/audit";
import { FIXTURE_AT, auditFixtureDrafts, fixtureAudit } from "../testing/mission-fixtures";
import { departmentFound, gradeAudit, workflowFound } from "./audit";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("fixture missing");
  return value;
}

const evalCase = required(loadAuditDataset()[0]);
const targets = { maxLatencyMs: 180_000, maxCostMicroUsd: 0, maxTokens: 300_000 };

function log(content: unknown): RunEvent[] {
  return auditFixtureDrafts(evalCase, content).map((draft, index) =>
    parseRunEvent({ ...draft, runId: "run_audit", seq: index + 1, at: FIXTURE_AT }),
  );
}

function kinds(grade: ReturnType<typeof gradeAudit>, passed: boolean): string[] {
  return grade.checks.filter((c) => c.passed === passed && c.skipped !== true).map((c) => c.kind);
}

describe("gradeAudit", () => {
  it("passes a valid, cited, specific audit and measures hint recall", () => {
    const grade = gradeAudit({ evalCase: evalCase, events: log(fixtureAudit(evalCase)), targets });
    expect(grade.hardFailures).toEqual([]);
    expect(kinds(grade, false)).toEqual([]);
    expect(grade.missionMetrics.opportunities).toBe(5);
    expect(grade.missionMetrics.workflowRecall).toBeGreaterThan(0);
    expect(grade.citationsVerified).toBe(true);
    expect(grade.checks.find((c) => c.kind === "no_dead_links")?.skipped).toBe(true);
  });

  it("fails a thin audit, dangling citations and generic ideas", () => {
    const audit = fixtureAudit(evalCase);
    const thin = { ...audit, opportunities: audit.opportunities.slice(0, 3) };
    expect(gradeAudit({ evalCase: evalCase, events: log(thin), targets }).hardFailures).toEqual([
      "opportunity_count",
    ]);
    const generic = {
      ...audit,
      opportunities: audit.opportunities.map((o, index) =>
        index === 0 ? { ...o, automation: "Use AI for customer support" } : o,
      ),
    };
    const genericGrade = gradeAudit({ evalCase: evalCase, events: log(generic), targets });
    expect(kinds(genericGrade, false)).toContain("no_generic_ideas");
    const dangling = {
      ...audit,
      opportunities: audit.opportunities.map((o) => ({
        ...o,
        evidence: [{ text: "x", citations: ["S9"] }],
      })),
    };
    expect(gradeAudit({ evalCase: evalCase, events: log(dangling), targets }).hardFailures).toEqual(
      ["schema_valid", "opportunity_count", "citations_resolve"],
    );
  });

  it("checks dead links on cited sources when links were checked", () => {
    const grade = gradeAudit({
      evalCase: evalCase,
      events: log(fixtureAudit(evalCase)),
      targets,
      links: new Map([[`${new URL(evalCase.input.url).origin}/`, { ok: false, status: 404 }]]),
    });
    expect(kinds(grade, false)).toContain("no_dead_links");
    expect(grade.citationsVerified).toBe(false);
  });

  it("matches department and workflow hints case-insensitively on synonyms and terms", () => {
    const audit = fixtureAudit(evalCase);
    const [department] = evalCase.hints.departments;
    const [workflow] = evalCase.hints.workflows;
    if (department === undefined || workflow === undefined) throw new Error("hints missing");
    const renamed = {
      ...audit,
      opportunities: audit.opportunities.map((o) => ({
        ...o,
        department: "Other",
        title: "Unrelated",
        workflow: "Unrelated",
        automation: "Unrelated",
      })),
    };
    expect(departmentFound(renamed, department)).toBe(false);
    expect(workflowFound(renamed, workflow)).toBe(false);
    const first = renamed.opportunities[0];
    if (first === undefined) throw new Error("no opportunity");
    first.department = (department.synonyms[0] ?? department.name).toUpperCase();
    first.workflow = `We ${(workflow.terms[0] ?? "").toUpperCase()} by hand`;
    expect(departmentFound(renamed, department)).toBe(true);
    expect(workflowFound(renamed, workflow)).toBe(true);
  });

  it("renders the judge view with hints, ROI inputs and sources", () => {
    const text = renderAuditJudgeInput(evalCase, fixtureAudit(evalCase));
    expect(text).toContain(evalCase.hints.workflows[0]?.description ?? "?");
    expect(text).toContain("ROI inputs:");
    expect(text).toContain("[S1]");
  });
});
