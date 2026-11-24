import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { RESULTS_DIR } from "./cli";
import { datasetPath } from "./datasets/xray";
import {
  agreementReport,
  loadHumanLabels,
  renderAgreement,
  type JudgedTrial,
} from "./judge/calibration";
import { JudgeVerdictSchema } from "./judge/xray-judge";

const labels = loadHumanLabels(datasetPath("human-labels.v1.jsonl"));
const judged: JudgedTrial[] = labels.flatMap((label) => {
  const path = join(RESULTS_DIR, label.run, label.caseId, `${label.trial}.judge.json`);
  if (!existsSync(path)) return [];
  const record = JudgeVerdictSchema.safeParse(
    (JSON.parse(readFileSync(path, "utf8")) as { verdict?: unknown }).verdict,
  );
  return record.success
    ? [{ caseId: label.caseId, run: label.run, trial: label.trial, verdict: record.data }]
    : [];
});
process.stdout.write(`${renderAgreement(agreementReport(labels, judged))}\n`);
