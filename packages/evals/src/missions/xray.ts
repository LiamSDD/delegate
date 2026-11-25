import { XRAY_DATASET, datasetPath, loadXrayDataset, type XrayCase } from "../datasets/xray";
import {
  DEFAULT_XRAY_TARGETS,
  citedUrls,
  gradeXray,
  type GradedCheck,
  type XrayTargets,
} from "../graders/xray";
import {
  JUDGE_CRITERIA,
  JUDGE_PROMPT_FILE,
  JudgeVerdictSchema,
  renderJudgeInput,
} from "../judge/xray-judge";
import { type MissionAdapter } from "./adapter";

const CITATION_CHECKS: readonly string[] = ["citations_resolve", "quotes_in_sources"];

function citationsVerified(outcome: string, checks: readonly GradedCheck[]): boolean | null {
  if (outcome === "errored") return null;
  const counted = checks.filter(
    (entry) => CITATION_CHECKS.includes(entry.kind) && entry.skipped !== true,
  );
  return counted.length === 0 ? null : counted.every((entry) => entry.passed);
}

export const xrayMission: MissionAdapter<XrayCase, undefined> = {
  mission: "xray",
  title: "Company X-ray",
  runtimeMissionId: "company-xray",
  dataset: XRAY_DATASET,
  loadCases: (path) => loadXrayDataset(path ?? datasetPath()),
  subject: (evalCase) => evalCase.company.name,
  input: (evalCase) => evalCase.input,
  runtimePrompts: ["reader", "researcher", "synthesis"],
  defaultTargets: DEFAULT_XRAY_TARGETS,
  citedUrls,
  grade({ evalCase, events, targets, links }) {
    const xrayTargets: XrayTargets = { ...DEFAULT_XRAY_TARGETS, ...targets };
    for (const check of evalCase.checks)
      if (check.kind === "min_citations") xrayTargets.minCitations = check.min;
    const grade = gradeXray({
      events,
      targets: xrayTargets,
      ...(links === undefined ? {} : { links }),
    });
    const { claims, citations, sources, sectionsCovered, sectionsInsufficient, ...metrics } =
      grade.metrics;
    return {
      outcome: grade.outcome,
      ...(grade.failureCode === undefined ? {} : { failureCode: grade.failureCode }),
      checks: grade.checks,
      hardFailures: grade.hardFailures,
      metrics,
      missionMetrics: { claims, citations, sources, sectionsCovered, sectionsInsufficient },
      serving: grade.serving,
      deliverable: grade.brief,
      citationsVerified: citationsVerified(grade.outcome, grade.checks),
    };
  },
  judge: {
    promptFile: JUDGE_PROMPT_FILE,
    criteria: JUDGE_CRITERIA,
    schema: JudgeVerdictSchema,
    render: (evalCase, deliverable) => renderJudgeInput(evalCase, deliverable),
    ready: (grade) => grade.checks.some((c) => c.kind === "schema_valid" && c.passed),
  },
};
