import {
  AUTOMATION_AUDIT_KIND,
  AutomationAuditSchema,
  MAX_OPPORTUNITIES,
  MIN_OPPORTUNITIES,
  estimateRoi,
  matchGeneric,
  type AutomationAudit,
  type Opportunity,
  type RunEvent,
} from "@delegate/runtime";

import { type AuditCase, type DepartmentHint, type WorkflowHint } from "../datasets/audit";
import { linkCheck, runCompletedCheck, type MissionGrade } from "../missions/adapter";
import {
  budgetChecks,
  hardFailuresOf,
  hygieneChecks,
  lastArtifactContent,
  runMetrics,
  runOutcome,
  servingFrom,
  type BudgetTargets,
  type GradedCheck,
} from "./run-metrics";
import { normaliseText, type LinkStatus } from "./xray";

export const AUDIT_TARGETS = { minHintRecall: 0.5 } as const;
export const AUDIT_HARD_CHECKS = [
  "run_completed",
  "schema_valid",
  "opportunity_count",
  "citations_resolve",
] as const;

export function finalAudit(events: readonly RunEvent[]): unknown {
  return lastArtifactContent(events, AUTOMATION_AUDIT_KIND);
}

export function auditCitedUrls(events: readonly RunEvent[]): string[] {
  const parsed = AutomationAuditSchema.safeParse(finalAudit(events));
  if (!parsed.success) return [];
  const cited = new Set(
    parsed.data.opportunities.flatMap((o) => o.evidence.flatMap((e) => e.citations)),
  );
  return [...new Set(parsed.data.sources.filter((s) => cited.has(s.sourceId)).map((s) => s.url))];
}

function contains(haystack: string, needle: string): boolean {
  return normaliseText(haystack).includes(normaliseText(needle));
}

export function departmentFound(audit: AutomationAudit, hint: DepartmentHint): boolean {
  const terms = [hint.name, ...hint.synonyms];
  return audit.opportunities.some((o) =>
    terms.some((term) => contains(`${o.department} ${o.title}`, term)),
  );
}

export function workflowFound(audit: AutomationAudit, hint: WorkflowHint): boolean {
  return audit.opportunities.some((o) =>
    hint.terms.some((term) => contains(`${o.title} ${o.workflow} ${o.automation}`, term)),
  );
}

function genericOpportunities(audit: AutomationAudit): string[] {
  return audit.opportunities.flatMap((o: Opportunity) => {
    const label = matchGeneric(`${o.title}. ${o.workflow} ${o.automation}`);
    return label === undefined ? [] : [`${o.id}: ${label}`];
  });
}

function recallCheck(kind: string, found: number, total: number, names: string[]): GradedCheck {
  const recall = total === 0 ? 1 : found / total;
  return {
    kind,
    severity: "soft",
    passed: recall >= AUDIT_TARGETS.minHintRecall,
    detail: `${found}/${total} found (min ${AUDIT_TARGETS.minHintRecall * 100}%)${names.length === 0 ? "" : `; missed: ${names.join(", ")}`}`,
  };
}

export function gradeAudit(input: {
  evalCase: AuditCase;
  events: readonly RunEvent[];
  targets: BudgetTargets;
  links?: ReadonlyMap<string, LinkStatus>;
}): MissionGrade {
  const { evalCase, events } = input;
  const { outcome, failureCode } = runOutcome(events);
  const raw = finalAudit(events);
  const parsed = AutomationAuditSchema.safeParse(raw);
  const checks: GradedCheck[] = [runCompletedCheck(outcome, failureCode)];
  const metrics = runMetrics(events);
  const missionMetrics: Record<string, number> = {};
  if (!parsed.success) {
    checks.push({
      kind: "schema_valid",
      severity: "hard",
      passed: false,
      detail:
        raw === undefined
          ? "no automation-audit artifact"
          : parsed.error.issues
              .slice(0, 3)
              .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
              .join("; "),
    });
    for (const kind of ["opportunity_count", "citations_resolve"])
      checks.push({ kind, severity: "hard", passed: false, detail: "no valid audit" });
  } else {
    const audit = parsed.data;
    const known = new Set(audit.sources.map((s) => s.sourceId));
    const citations = audit.opportunities.flatMap((o) => o.evidence.flatMap((e) => e.citations));
    const dangling = citations.filter((id) => !known.has(id));
    const count = audit.opportunities.length;
    checks.push(
      { kind: "schema_valid", severity: "hard", passed: true },
      {
        kind: "opportunity_count",
        severity: "hard",
        passed: count >= MIN_OPPORTUNITIES && count <= MAX_OPPORTUNITIES,
        detail: `${count} opportunities (expected ${MIN_OPPORTUNITIES} to ${MAX_OPPORTUNITIES})`,
      },
      {
        kind: "citations_resolve",
        severity: "hard",
        passed: citations.length > 0 && dangling.length === 0,
        detail: `${citations.length - dangling.length}/${citations.length} evidence citations resolve to a listed source`,
      },
    );
    const shortfall = audit.shortfall;
    checks.push({
      kind: "shortfall_flagged",
      severity: "soft",
      passed: count >= MIN_OPPORTUNITIES ? shortfall === undefined : shortfall?.found === count,
      detail:
        count >= MIN_OPPORTUNITIES
          ? shortfall === undefined
            ? "no shortfall to flag"
            : "flags a shortfall it does not have"
          : shortfall === undefined
            ? `${count} opportunities and no insufficient-evidence flag`
            : `flags insufficient evidence (${shortfall.found} of ${shortfall.minimum})`,
    });
    const generic = genericOpportunities(audit);
    checks.push({
      kind: "no_generic_ideas",
      severity: "soft",
      passed: generic.length === 0,
      detail: generic.length === 0 ? "none match a generic pattern" : generic.join("; "),
    });
    const departments = evalCase.hints.departments.map((hint) => ({
      hint,
      found: departmentFound(audit, hint),
    }));
    const workflows = evalCase.hints.workflows.map((hint) => ({
      hint,
      found: workflowFound(audit, hint),
    }));
    const foundDepartments = departments.filter((d) => d.found).length;
    const foundWorkflows = workflows.filter((w) => w.found).length;
    checks.push(
      recallCheck(
        "departments_found",
        foundDepartments,
        departments.length,
        departments.filter((d) => !d.found).map((d) => d.hint.id),
      ),
      recallCheck(
        "workflows_found",
        foundWorkflows,
        workflows.length,
        workflows.filter((w) => !w.found).map((w) => w.hint.id),
      ),
    );
    const verified = audit.opportunities.filter((o) => o.verification === "verified").length;
    Object.assign(missionMetrics, {
      opportunities: count,
      eurPerMonth: audit.opportunities.reduce((sum, o) => sum + estimateRoi(o).eurPerMonth, 0),
      departmentRecall: departments.length === 0 ? 0 : foundDepartments / departments.length,
      workflowRecall: workflows.length === 0 ? 0 : foundWorkflows / workflows.length,
      verifiedShare: count === 0 ? 0 : verified / count,
      genericIdeas: generic.length,
      evidenceCitations: citations.length,
    });
  }
  checks.push(linkCheck(auditCitedUrls(events), input.links));
  checks.push(...budgetChecks(metrics, input.targets), ...hygieneChecks(events, metrics));
  const resolve = checks.find((c) => c.kind === "citations_resolve");
  const links = checks.find((c) => c.kind === "no_dead_links");
  return {
    outcome,
    ...(failureCode === undefined ? {} : { failureCode }),
    checks,
    hardFailures: hardFailuresOf(outcome, checks),
    metrics,
    missionMetrics,
    serving: servingFrom(events),
    deliverable: raw,
    citationsVerified:
      outcome === "errored" || resolve === undefined
        ? null
        : resolve.passed && (links?.skipped === true || links?.passed !== false),
  };
}
