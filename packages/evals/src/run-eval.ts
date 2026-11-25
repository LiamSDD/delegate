import { liveDeps, parseEvalArgs } from "./cli";
import { runDir } from "./judge/agreement-store";
import { runEval } from "./runner";

const parsed = parseEvalArgs(process.argv.slice(2), { trials: 3 });
const deps = liveDeps(parsed);
for (const mission of parsed.missions) {
  const summary = await runEval({ ...parsed, mission }, deps);
  process.stdout.write(
    `${summary.mode === "replay" ? "Replay" : "Live"} ${summary.title} eval ${summary.id}: pass ${(summary.overall.passRate.rate * 100).toFixed(0)}% (n=${summary.overall.passRate.n}), hard failures ${summary.overall.hardFailures}, errored ${summary.overall.errored}, regressions ${summary.regressions.length}\n${runDir(parsed.resultsDir, mission, summary.id)}/summary.md\n`,
  );
}
