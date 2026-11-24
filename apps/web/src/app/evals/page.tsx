import type { Metadata } from "next";

import { ArrivalPage } from "@/components/arrival-page";

export const metadata: Metadata = { title: "Evals" };

export default function EvalsPage() {
  return (
    <ArrivalPage
      section="Evals"
      milestone="M4"
      title="Quality, measured with error bars"
      summary="A per-mission scoreboard built from repeated trials on golden cases, so a regression is a statistic rather than an anecdote."
      willShow={[
        "Pass rate per mission, as mean ± 95% confidence interval",
        "Citation accuracy and attack success rate, which must stay at 0%",
        "Cost against quality as a Pareto chart across model and prompt versions",
        "Agreement between the LLM judge and human labels",
        "The last local gate run and what it rejected",
      ]}
    >
      <p className="border-l-2 border-border-strong pl-4 text-sm text-text-muted">
        The eval harness itself starts in M1 on the command line:{" "}
        <code className="font-mono text-xs text-text">pnpm eval --mission xray</code>
      </p>
    </ArrivalPage>
  );
}
