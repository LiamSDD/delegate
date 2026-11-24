import type { Metadata } from "next";

import { ArrivalPage } from "@/components/arrival-page";

export const metadata: Metadata = { title: "Mission Control" };

export default function ControlPage() {
  return (
    <ArrivalPage
      section="Mission Control"
      milestone="M7"
      title="Everything running, and what it costs"
      summary="One place for an operator to see active work, clear approvals and keep spend inside budget."
      willShow={[
        "Active runs across the workspace",
        "The approval queue, with the policy that asked for each approval",
        "Spend against budget, per run and per day",
        "Standing missions and the triggers that start them",
        "Estimated ROI delivered, labelled as an estimate with its formula",
      ]}
    />
  );
}
