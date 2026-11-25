import type { Metadata } from "next";
import Link from "next/link";

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
    >
      <p className="border-l-2 border-border-strong pl-4 text-sm text-text-muted">
        Available now:{" "}
        <Link
          href="/control/audit"
          className="text-text underline underline-offset-4 hover:text-accent"
        >
          the audit log
        </Link>
        , every allowed, denied and approval-gated tool call in your workspace.
      </p>
    </ArrivalPage>
  );
}
