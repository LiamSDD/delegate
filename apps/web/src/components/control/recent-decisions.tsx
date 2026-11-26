import type { PolicyDecisionKind } from "@delegate/runtime";
import { ArrowRight } from "lucide-react";
import Link from "next/link";

import { actionButton, Chip, type Tone } from "@/components/run/primitives";
import { missionLabel } from "@/lib/m2-contract";
import type { AuditListing } from "@/server/audit";

import { formatCount, shortId, utcDateTime } from "./format";
import { EmptyState } from "./section";

const DECISION: Record<PolicyDecisionKind, { label: string; tone: Tone }> = {
  allow: { label: "Allowed", tone: "success" },
  deny: { label: "Denied", tone: "danger" },
  require_approval: { label: "Needs approval", tone: "warning" },
};

export function AuditLink() {
  return (
    <Link href="/control/audit" className={actionButton}>
      Open the audit log
      <ArrowRight className="size-3.5" aria-hidden="true" />
    </Link>
  );
}

export function RecentDecisions({ decisions }: { decisions: AuditListing }) {
  const total = decisions.counts.allow + decisions.counts.deny + decisions.counts.require_approval;
  if (decisions.entries.length === 0)
    return (
      <EmptyState title="No policy decisions yet">
        The policy engine checks every tool call before it runs. Its newest decisions for this
        workspace appear here, each with the tool, the policy that decided and the run it belongs
        to.
      </EmptyState>
    );
  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col rounded-xl border border-border bg-surface shadow-sm">
        {decisions.entries.map((entry) => {
          const decision = DECISION[entry.decision];
          return (
            <li
              key={`${entry.runId}:${String(entry.seq)}`}
              className="flex min-w-0 flex-col gap-1.5 border-b border-border px-4 py-3 last:border-b-0"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                <Chip tone={decision.tone}>{decision.label}</Chip>
                <span className="min-w-0 font-mono text-sm break-all text-text">{entry.tool}</span>
                <time
                  dateTime={entry.at.toISOString()}
                  className="font-mono text-2xs text-text-subtle tabular sm:ml-auto"
                >
                  {utcDateTime.format(entry.at)} UTC
                </time>
              </div>
              <p className="text-sm break-words text-text-muted">{entry.reason}</p>
              <p className="font-mono text-2xs break-words text-text-subtle">
                policy {entry.policyId} · {missionLabel(entry.mission)} ·{" "}
                <Link
                  href={`/runs/${entry.runId}`}
                  className="text-text-muted underline underline-offset-4 hover:text-accent"
                >
                  {entry.target ?? shortId(entry.runId)}
                </Link>
              </p>
            </li>
          );
        })}
      </ol>
      <p className="text-sm text-text-subtle">
        The newest {formatCount(decisions.entries.length)} of {formatCount(total)} decisions:{" "}
        {formatCount(decisions.counts.allow)} allowed, {formatCount(decisions.counts.deny)} denied,{" "}
        {formatCount(decisions.counts.require_approval)} sent for approval.
      </p>
    </div>
  );
}
