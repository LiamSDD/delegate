import { liveDeps, parseEvalArgs } from "./cli";
import { gateVerdict } from "./gate-verdict";
import { runEval } from "./runner";

const full = process.env.GATE_FULL === "1";
const parsed = parseEvalArgs(process.argv.slice(2), { trials: full ? 3 : 1 });
const options = full ? parsed : { ...parsed, tag: parsed.tag ?? "gate" };
const summary = await runEval(options, liveDeps(options));
const verdict = gateVerdict(summary);
process.stdout.write(`gate (${full ? "full" : "cheap"}, ${summary.mode}): ${verdict.message}\n`);
process.exitCode = verdict.ok ? 0 : 1;
