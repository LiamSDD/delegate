import { AutomationAuditSchema, estimateRoi } from "@delegate/runtime";

import { AUDIT_DATASET, loadAuditDataset, type AuditCase } from "../datasets/audit";
import { auditCitedUrls, gradeAudit } from "../graders/audit";
import { rubricVerdictSchema } from "../judge/rubric-judge";
import { type MissionAdapter } from "./adapter";

export const AUDIT_JUDGE_CRITERIA = [
  "specificity",
  "evidenceSupport",
  "roiPlausibility",
  "actionability",
] as const;

export function renderAuditJudgeInput(evalCase: AuditCase, deliverable: unknown): string {
  const audit = AutomationAuditSchema.parse(deliverable);
  const lines = [
    `Company: ${evalCase.company.name} (${evalCase.input.url}); size band ${evalCase.company.size}, industry ${evalCase.company.industry}`,
    ...(evalCase.input.department === undefined
      ? []
      : [`Requested department: ${evalCase.input.department}`]),
    "",
    "## Verified hints (departments and workflows the company's own site documents)",
    ...evalCase.hints.departments.map((hint) => `- department ${hint.id}: ${hint.name}`),
    ...evalCase.hints.workflows.map((hint) => `- workflow ${hint.id}: ${hint.description}`),
    "",
    `## Audit summary`,
    audit.summary,
    "",
    `## Opportunities (ranked; ${audit.formula})`,
  ];
  for (const [index, o] of audit.opportunities.entries()) {
    const roi = estimateRoi(o);
    lines.push(
      `### ${index + 1}. ${o.title} [${o.department}] difficulty ${o.difficulty}`,
      `Workflow: ${o.workflow}`,
      `Automation: ${o.automation}`,
      `ROI inputs: ${o.frequencyPerMonth}/month × ${o.minutesPerTask} min × ${o.peopleInvolved} people × adoption ${o.adoptionRate}; €${o.hourlyCostEur}/h → ${roi.hoursPerMonth} h, €${roi.eurPerMonth}/month`,
      `First step: ${o.firstStep}`,
      ...o.evidence.map((e) => `Evidence: ${e.text} [${e.citations.join(", ")}]`),
      ...o.assumptions.map((a) => `Assumption: ${a}`),
    );
  }
  lines.push(
    "",
    "## Sources",
    ...audit.sources.map((s) => `[${s.sourceId}] ${s.url} — ${s.title}`),
  );
  return lines.join("\n");
}

export const auditMission: MissionAdapter<AuditCase, undefined> = {
  mission: "audit",
  title: "AI Automation Audit",
  runtimeMissionId: "automation-audit",
  dataset: AUDIT_DATASET,
  loadCases: (path) => (path === undefined ? loadAuditDataset() : loadAuditDataset(path)),
  subject: (evalCase) => evalCase.company.name,
  input: (evalCase) => evalCase.input,
  runtimePrompts: ["planner", "reader", "researcher", "analyst", "auditEditor", "critic", "editor"],
  defaultTargets: { maxLatencyMs: 180_000, maxCostMicroUsd: 0, maxTokens: 300_000 },
  citedUrls: auditCitedUrls,
  grade: (input) => gradeAudit(input),
  judge: {
    promptFile: "audit-judge.v1.md",
    criteria: AUDIT_JUDGE_CRITERIA,
    schema: rubricVerdictSchema(AUDIT_JUDGE_CRITERIA),
    render: (evalCase, deliverable) => renderAuditJudgeInput(evalCase, deliverable),
    ready: (grade) => grade.checks.some((c) => c.kind === "schema_valid" && c.passed),
  },
};
