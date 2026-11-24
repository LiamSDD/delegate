import { join } from "node:path";

import { liveDeps, parseEvalArgs } from "./cli";
import { runEval } from "./runner";

const options = parseEvalArgs(process.argv.slice(2), { trials: 3 });
const summary = await runEval(options, liveDeps(options));
process.stdout.write(
  `${summary.mode === "replay" ? "Replay" : "Live"} eval ${summary.id}: pass ${(summary.overall.passRate.rate * 100).toFixed(0)}% (n=${summary.overall.passRate.n}), hard failures ${summary.overall.hardFailures}, errored ${summary.overall.errored}, regressions ${summary.regressions.length}\n${join(options.resultsDir, summary.id, "summary.md")}\n`,
);
