import type { Metadata } from "next";

import { ArrivalPage } from "@/components/arrival-page";

export const metadata: Metadata = { title: "Runs" };

export default function RunsPage() {
  return (
    <ArrivalPage
      section="Runs"
      milestone="M1"
      title="Every run, live and replayable"
      summary="The run view streams real events from the runtime: the plan, each sub-agent at work, every tool call and policy decision, and the deliverables as they form."
      willShow={[
        "The live plan as a step graph, with revisions shown as diffs",
        "Parallel sub-agent lanes with compact tool-call cards and policy decisions",
        "Amber critic flags and inline approval cards",
        "Deliverables rendering progressively, with citations on hover and exports",
        "Elapsed · steps · tokens · live $ · cache hit rate · model mix · Stop",
        "A trace waterfall per run, with Fork from here",
      ]}
    />
  );
}
