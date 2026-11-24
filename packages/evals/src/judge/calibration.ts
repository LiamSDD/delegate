import { existsSync, readFileSync } from "node:fs";

import { z } from "zod";

import { JUDGE_CRITERIA, type JudgeCriterion, type JudgeVerdict } from "./xray-judge";

const score = z.number().int().min(1).max(5);

export const HumanLabelSchema = z.strictObject({
  caseId: z.string().min(1),
  run: z.string().min(1),
  trial: z.number().int().nonnegative(),
  labeller: z.string().min(1),
  labelledAt: z.iso.date(),
  scores: z.strictObject({
    accuracy: score,
    specificity: score,
    actionability: score,
    citationFaithfulness: score,
  }),
  notes: z.string().optional(),
});
export type HumanLabel = z.infer<typeof HumanLabelSchema>;

export function parseHumanLabels(text: string): HumanLabel[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      const parsed = HumanLabelSchema.safeParse(JSON.parse(line) as unknown);
      if (!parsed.success) throw new Error(`Human label line ${index + 1} is invalid`);
      return parsed.data;
    });
}

export function loadHumanLabels(path: string): HumanLabel[] {
  return existsSync(path) ? parseHumanLabels(readFileSync(path, "utf8")) : [];
}

export function cohenKappa(a: readonly number[], b: readonly number[]): number | undefined {
  if (a.length !== b.length || a.length === 0) return undefined;
  const categories = [...new Set([...a, ...b])];
  const n = a.length;
  const observed = a.filter((value, index) => value === b[index]).length / n;
  const expected = categories.reduce(
    (sum, category) =>
      sum +
      (a.filter((value) => value === category).length / n) *
        (b.filter((value) => value === category).length / n),
    0,
  );
  if (expected === 1) return observed === 1 ? 1 : 0;
  return (observed - expected) / (1 - expected);
}

export interface CriterionAgreement {
  criterion: JudgeCriterion;
  n: number;
  exactMatchRate: number;
  withinOneRate: number;
  kappa: number | undefined;
}

export type AgreementReport =
  | { status: "no_human_labels"; labels: 0 }
  | { status: "no_matching_judgements"; labels: number; matched: 0 }
  | { status: "ok"; labels: number; matched: number; criteria: CriterionAgreement[] };

export interface JudgedTrial {
  caseId: string;
  run: string;
  trial: number;
  verdict: JudgeVerdict;
}

export function agreementReport(
  labels: readonly HumanLabel[],
  judged: readonly JudgedTrial[],
): AgreementReport {
  if (labels.length === 0) return { status: "no_human_labels", labels: 0 };
  const byKey = new Map(
    judged.map((entry) => [`${entry.run}/${entry.caseId}/${entry.trial}`, entry]),
  );
  const pairs = labels.flatMap((label) => {
    const match = byKey.get(`${label.run}/${label.caseId}/${label.trial}`);
    return match === undefined ? [] : [{ label, verdict: match.verdict }];
  });
  if (pairs.length === 0)
    return { status: "no_matching_judgements", labels: labels.length, matched: 0 };
  return {
    status: "ok",
    labels: labels.length,
    matched: pairs.length,
    criteria: JUDGE_CRITERIA.map((criterion) => {
      const human = pairs.map((pair) => pair.label.scores[criterion]);
      const judge = pairs.map((pair) => pair.verdict[criterion].score);
      const n = pairs.length;
      return {
        criterion,
        n,
        exactMatchRate: human.filter((value, index) => value === judge[index]).length / n,
        withinOneRate:
          human.filter((value, index) => Math.abs(value - (judge[index] ?? 0)) <= 1).length / n,
        kappa: cohenKappa(human, judge),
      };
    }),
  };
}

export function renderAgreement(report: AgreementReport): string {
  switch (report.status) {
    case "no_human_labels":
      return "No human labels yet: judge-human agreement is not measured. Add labels to `datasets/company-xray/human-labels.v1.jsonl`.";
    case "no_matching_judgements":
      return `${report.labels} human labels found, but none match a judged trial in the results.`;
    case "ok":
      return [
        `${report.matched} of ${report.labels} human labels matched a judged trial.`,
        "",
        "| Criterion | n | Exact match | Within 1 | Cohen's kappa |",
        "|---|---|---|---|---|",
        ...report.criteria.map(
          (row) =>
            `| ${row.criterion} | ${row.n} | ${(row.exactMatchRate * 100).toFixed(0)}% | ${(row.withinOneRate * 100).toFixed(0)}% | ${row.kappa === undefined ? "n/a" : row.kappa.toFixed(2)} |`,
        ),
      ].join("\n");
  }
}
