import { parseArgs } from "node:util";

import { z } from "zod";

import { RESULTS_DIR } from "./cli";
import { missionAgreement, writeCalibration } from "./judge/agreement-store";
import { renderAgreement } from "./judge/calibration";
import { EVAL_MISSIONS, missionAdapter } from "./missions";

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== "--"),
  options: { mission: { type: "string", default: "all" } },
  strict: true,
});
const mission = z.enum([...EVAL_MISSIONS, "all"]).parse(values.mission);
for (const name of mission === "all" ? EVAL_MISSIONS : [mission]) {
  const adapter = missionAdapter(name);
  const report = missionAgreement(RESULTS_DIR, adapter);
  if (report.status !== "no_human_labels")
    writeCalibration(RESULTS_DIR, adapter, report, new Date());
  process.stdout.write(
    `## ${adapter.title}\n\n${renderAgreement(report, `datasets/${adapter.dataset.name}/human-labels.v1.jsonl`)}\n\n`,
  );
}
