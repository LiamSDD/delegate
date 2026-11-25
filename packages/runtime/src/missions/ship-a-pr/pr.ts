import { createHash } from "node:crypto";

import { type TestRunSummary } from "../../events";
import { type ShipImprovement } from "./input";
import { PR_FOOTER, describeRun, type DiffFile, type ShipTestReport } from "./schema";

export { describeRun };

const COMMIT_PREFIX: Record<ShipImprovement["kind"], string> = {
  test: "test",
  bugfix: "fix",
  refactor: "refactor",
  docs: "docs",
  deps: "chore(deps)",
  security: "fix(security)",
};

export function shortHash(text: string, length = 7): string {
  return createHash("sha256").update(text).digest("hex").slice(0, length);
}

export function slug(text: string, max = 40): string {
  const value = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return value === "" ? "change" : value;
}

export function branchName(improvement: ShipImprovement, runId: string): string {
  return `delegate/${slug(improvement.id, 30)}-${shortHash(runId)}`;
}

export function approvalIdFor(runId: string): string {
  return `ship_${shortHash(runId, 16)}`;
}

export function commitMessage(improvement: ShipImprovement, runId: string): string {
  const subject = `${COMMIT_PREFIX[improvement.kind]}: ${improvement.title}`.slice(0, 100);
  return `${subject}\n\n${improvement.rationale.slice(0, 1_500)}\n\nDelegate-Run: ${runId}\n`;
}

function row(label: string, before: TestRunSummary | null, after: TestRunSummary | null): string {
  const command = after?.command ?? before?.command;
  if (command === null || command === undefined) return "";
  return `| ${label} | \`${command}\` | ${before === null ? "n/a" : describeRun(before)} | ${after === null ? "n/a" : describeRun(after)} |`;
}

export function testEvidence(baseline: ShipTestReport, after: ShipTestReport): string {
  const rows = [
    row("Tests", baseline.test, after.test),
    row("Lint", baseline.lint, after.lint),
    row("Typecheck", baseline.typecheck, after.typecheck),
  ].filter((line) => line !== "");
  if (rows.length === 0)
    return "No test, lint or typecheck command was detected in this repository.";
  return ["| Check | Command | Before | After |", "|---|---|---|---|", ...rows].join("\n");
}

export function pullRequestBody(options: {
  improvement: ShipImprovement;
  baseline: ShipTestReport;
  after: ShipTestReport;
  files: readonly DiffFile[];
  runId: string;
}): string {
  const { improvement } = options;
  const files = options.files
    .map((file) => `- \`${file.path}\` (${file.status}, +${file.additions} −${file.deletions})`)
    .join("\n");
  return [
    improvement.rationale,
    "### Acceptance criteria",
    improvement.acceptance.map((item) => `- [ ] ${item}`).join("\n"),
    "### Test evidence",
    testEvidence(options.baseline, options.after),
    "### Changed files",
    files,
    "---",
    `${PR_FOOTER} Run \`${options.runId}\`.`,
  ].join("\n\n");
}

export function testReportText(options: {
  repo: string;
  baseSha: string;
  improvement: ShipImprovement;
  baseline: ShipTestReport;
  after: ShipTestReport;
}): string {
  return [
    `# Test report: ${options.improvement.title}`,
    `Repository: ${options.repo} at ${options.baseSha}`,
    testEvidence(options.baseline, options.after),
    "## Output after the change (tail)",
    "```",
    options.after.testOutput,
    "```",
    `Apply with: git apply ${slug(options.improvement.id, 30)}.patch`,
  ].join("\n\n");
}
