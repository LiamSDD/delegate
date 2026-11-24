import { type EvalSummary } from "./runner";

export function gateVerdict(summary: EvalSummary): { ok: boolean; message: string } {
  const reasons: string[] = [];
  if (summary.overall.hardFailures > 0)
    reasons.push(
      `${summary.overall.hardFailures} trial(s) failed schema, citation or quote checks`,
    );
  for (const regression of summary.regressions)
    reasons.push(
      `${regression.scope} ${regression.metric} regressed by ${regression.worsening?.toFixed(3) ?? "?"} (p=${regression.pValue?.toFixed(3) ?? "?"})`,
    );
  if (summary.overall.trials > 0 && summary.overall.errored === summary.overall.trials)
    reasons.push("every trial errored on infrastructure, so there is no evidence either way");
  return reasons.length === 0
    ? {
        ok: true,
        message: `passed: ${summary.overall.trials} trials, ${summary.overall.errored} errored, no hard failures or meaningful regressions`,
      }
    : { ok: false, message: `failed: ${reasons.join("; ")}` };
}
