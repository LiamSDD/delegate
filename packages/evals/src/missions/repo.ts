import { RepoXraySchema, formatCitation, type Citation } from "@delegate/runtime";

import { REPO_XRAY_DATASET, loadRepoXrayDataset, type RepoXrayCase } from "../datasets/repo-xray";
import { gradeRepoXray, repoArtifacts } from "../graders/repo-xray";
import {
  budgetChecks,
  hardFailuresOf,
  hygieneChecks,
  runMetrics,
  runOutcome,
  servingFrom,
} from "../graders/run-metrics";
import { rubricVerdictSchema } from "../judge/rubric-judge";
import { runCompletedCheck, type MissionAdapter } from "./adapter";

export const REPO_JUDGE_CRITERIA = [
  "accuracy",
  "specificity",
  "actionability",
  "onboardingClarity",
] as const;

const cite = (citations: readonly Citation[]) => citations.map(formatCitation).join(", ");

export function renderRepoJudgeInput(evalCase: RepoXrayCase, deliverable: unknown): string {
  const xray = RepoXraySchema.parse(deliverable);
  const lines = [
    `Repository: ${xray.repo.owner}/${xray.repo.name} (${xray.repo.url}) at ${xray.repo.ref}`,
    "",
    "## Expected facts",
    ...evalCase.expectedFacts.map((f) => `- ${f.id} (${f.kind}): ${f.proposition}`),
    "",
    "## Languages",
    ...xray.languages.slice(0, 5).map((l) => `- ${l.language} ${(l.share * 100).toFixed(0)}%`),
    "",
    "## Architecture summary",
    ...xray.architecture.summary.map((c) => `- ${c.text} [${cite(c.citations)}]`),
    "",
    "## Modules",
    ...xray.modules
      .slice(0, 20)
      .map(
        (m) =>
          `- ${m.path} (${m.files} files, imported by ${m.importedBy})${m.responsibility === null ? "" : `: ${m.responsibility.text}`}`,
      ),
    "",
    "## Onboarding",
    ...xray.onboarding.steps.map(
      (s) => `- ${s.title}: ${s.claim.text} [${cite(s.claim.citations)}]`,
    ),
    ...xray.onboarding.entryPoints.map((e) => `- entry point ${e.path} (${e.kind})`),
    "",
    "## Tests and CI",
    `- frameworks: ${xray.tests.frameworks.map((f) => f.name).join(", ") || "none detected"}`,
    `- CI: ${xray.tests.ci.map((c) => c.provider).join(", ") || "none detected"}`,
    ...xray.tests.gaps
      .slice(0, 8)
      .map((g) => `- untested: ${g.file} (imported by ${g.importedBy})`),
    "",
    "## Hotspots",
    ...xray.hotspots.slice(0, 10).map((h) => `- [${h.severity}] ${h.title}: ${h.detail}`),
    "",
    "## Improvements (ranked)",
  ];
  for (const i of xray.improvements)
    lines.push(
      `### ${i.rank}. ${i.title} (${i.kind}, effort ${i.effort})`,
      `Rationale: ${i.rationale} [${cite(i.citations)}]`,
      `Files: ${i.files.join(", ")}`,
      ...i.acceptance.map((a) => `Acceptance: ${a}`),
    );
  return lines.join("\n");
}

export const repoMission: MissionAdapter<RepoXrayCase, undefined> = {
  mission: "repo",
  title: "Repo X-ray",
  runtimeMissionId: "repo-xray",
  dataset: REPO_XRAY_DATASET,
  loadCases: (path) => (path === undefined ? loadRepoXrayDataset() : loadRepoXrayDataset(path)),
  subject: (evalCase) => `${evalCase.repo.owner}/${evalCase.repo.name}`,
  input: (evalCase) => evalCase.input,
  runtimePrompts: ["planner", "reader", "repoArchitect", "repoImprover", "critic", "editor"],
  defaultTargets: { maxLatencyMs: 240_000, maxCostMicroUsd: 0, maxTokens: 300_000 },
  hardDeadlineMs: 600_000,
  citedUrls: () => [],
  grade({ evalCase, events, targets }) {
    const { outcome, failureCode } = runOutcome(events);
    const metrics = runMetrics(events);
    const artifacts = repoArtifacts(events);
    const grade = gradeRepoXray(evalCase, artifacts);
    const checks = [
      runCompletedCheck(outcome, failureCode),
      ...grade.checks,
      ...budgetChecks(metrics, targets),
      ...hygieneChecks(events, metrics),
    ];
    const xray = RepoXraySchema.safeParse(artifacts.xray);
    const found = grade.facts.filter((f) => f.found).length;
    const resolve = checks.find((c) => c.kind === "citations_resolve");
    return {
      outcome,
      ...(failureCode === undefined ? {} : { failureCode }),
      checks,
      hardFailures: hardFailuresOf(outcome, checks),
      metrics,
      missionMetrics: {
        factRecall: grade.facts.length === 0 ? 0 : found / grade.facts.length,
        ...(xray.success
          ? {
              improvements: xray.data.improvements.length,
              modules: xray.data.modules.length,
              hotspots: xray.data.hotspots.length,
              citationsChecked: xray.data.verification.citationsChecked,
            }
          : {}),
      },
      serving: servingFrom(events),
      deliverable: artifacts.xray,
      citationsVerified: outcome === "errored" || resolve === undefined ? null : resolve.passed,
    };
  },
  judge: {
    promptFile: "repo-judge.v1.md",
    criteria: REPO_JUDGE_CRITERIA,
    schema: rubricVerdictSchema(REPO_JUDGE_CRITERIA),
    render: (evalCase, deliverable) => renderRepoJudgeInput(evalCase, deliverable),
    ready: (grade) => grade.checks.some((c) => c.kind === "schema_valid" && c.passed),
  },
};
