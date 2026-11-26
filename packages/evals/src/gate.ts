import { liveDeps, parseEvalArgs } from "./cli";
import { runMissionGates } from "./evolve/gate-run";

const full = process.env.GATE_FULL === "1";
const argv = process.argv.slice(2);
const parsed = parseEvalArgs(argv, { trials: full ? 3 : 1, mission: "all" });
const thresholdGiven = argv.some((arg) => arg === "--threshold" || arg.startsWith("--threshold="));
const { missions, ...base } = parsed;
const result = await runMissionGates(
  { missions, full, base, ...(thresholdGiven ? { threshold: parsed.threshold } : {}) },
  liveDeps(parsed),
);
for (const verdict of result.verdicts)
  process.stdout.write(
    `gate ${verdict.mission} (${full ? "full" : "cheap"}, ${verdict.mode}): ${verdict.message}\n`,
  );
process.stdout.write(
  `gate: ${result.verdicts.filter((verdict) => verdict.ok).length}/${result.verdicts.length} missions passed\n`,
);
process.exitCode = result.ok ? 0 : 1;
