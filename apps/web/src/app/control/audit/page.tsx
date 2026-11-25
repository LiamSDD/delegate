import type { Metadata } from "next";
import Link from "next/link";

import type { PolicyDecisionKind } from "@delegate/runtime";

import { missionLabel } from "@/lib/m2-contract";
import {
  AUDIT_PAGE_SIZE,
  listPolicyDecisions,
  parseDecisionFilter,
  POLICY_DECISIONS,
  type AuditListing,
} from "@/server/audit";
import { currentGuest } from "@/server/page-session";

export const metadata: Metadata = { title: "Audit log" };

const DECISION: Record<PolicyDecisionKind, { label: string; className: string }> = {
  allow: { label: "Allowed", className: "bg-success-soft text-success" },
  deny: { label: "Denied", className: "bg-danger-soft text-danger" },
  require_approval: { label: "Needs approval", className: "bg-warning-soft text-warning" },
};

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "medium",
  timeZone: "UTC",
});

function FilterLink({
  decision,
  active,
  count,
}: {
  decision: PolicyDecisionKind | undefined;
  active: boolean;
  count: number;
}) {
  return (
    <Link
      href={decision === undefined ? "/control/audit" : `/control/audit?decision=${decision}`}
      aria-current={active ? "page" : undefined}
      className={`inline-flex h-8 items-center gap-2 rounded-md border px-3 text-sm ${
        active
          ? "border-border-strong bg-surface text-text shadow-sm"
          : "border-border text-text-muted hover:border-border-strong hover:text-text"
      }`}
    >
      {decision === undefined ? "All" : DECISION[decision].label}
      <span className="font-mono text-2xs text-text-subtle tabular">{count}</span>
    </Link>
  );
}

function Entries({ listing }: { listing: AuditListing }) {
  return (
    <ol className="flex flex-col rounded-xl border border-border bg-surface shadow-sm">
      {listing.entries.map((entry) => {
        const decision = DECISION[entry.decision];
        return (
          <li
            key={`${entry.runId}:${entry.seq}`}
            className="grid gap-2 border-b border-border px-4 py-3 last:border-b-0 md:grid-cols-[9rem_minmax(0,1fr)_12rem] md:gap-6"
          >
            <div className="flex items-center gap-3 md:flex-col md:items-start md:gap-1.5">
              <span
                className={`inline-flex h-5 items-center rounded-sm px-1.5 font-mono text-2xs ${decision.className}`}
              >
                {decision.label}
              </span>
              <time
                dateTime={entry.at.toISOString()}
                className="font-mono text-2xs text-text-subtle tabular"
              >
                {dateFormat.format(entry.at)}
              </time>
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <p className="font-mono text-sm text-text">
                {entry.tool}
                <span className="text-text-subtle"> · policy {entry.policyId}</span>
              </p>
              <p className="text-sm break-words text-text-muted">{entry.reason}</p>
              {entry.redactions > 0 ? (
                <p className="font-mono text-2xs text-text-subtle">
                  {entry.redactions} personal {entry.redactions === 1 ? "value" : "values"} redacted
                </p>
              ) : null}
            </div>
            <div className="flex flex-col gap-1 md:items-end md:text-right">
              <Link
                href={`/runs/${entry.runId}`}
                className="font-mono text-sm text-text underline decoration-border-strong underline-offset-4 hover:text-accent hover:decoration-accent"
              >
                {entry.target ?? entry.runId.slice(0, 8)}
              </Link>
              <span className="font-mono text-2xs text-text-subtle">
                {missionLabel(entry.mission)}
                {entry.stepId === null ? "" : ` · step ${entry.stepId}`} · event #{entry.seq}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export default async function AuditPage({ searchParams }: PageProps<"/control/audit">) {
  const decision = parseDecisionFilter((await searchParams).decision);
  const guest = await currentGuest();
  const listing =
    guest === null
      ? null
      : await listPolicyDecisions(
          guest.app,
          guest.session,
          decision === undefined ? {} : { decision },
        );
  const total =
    listing === null ? 0 : POLICY_DECISIONS.reduce((sum, kind) => sum + listing.counts[kind], 0);

  return (
    <div className="mx-auto flex max-w-content flex-col gap-8 px-4 pt-16 pb-24 sm:px-6 md:pt-24">
      <header className="flex flex-col gap-4">
        <p className="font-mono text-2xs tracking-label text-text-subtle uppercase">
          <Link href="/control" className="hover:text-text">
            Mission Control
          </Link>{" "}
          <span aria-hidden="true">/</span> Audit log
        </p>
        <h1 className="font-serif text-display-md tracking-display text-balance">
          Every policy decision, newest first
        </h1>
        <p className="max-w-2xl text-md text-text-muted text-pretty">
          The policy engine evaluates each tool call before it runs. These are its decisions for
          your workspace, read from the append-only run event log, with the run each one belongs to.
        </p>
      </header>

      {listing === null || total === 0 ? (
        <div className="flex flex-col items-start gap-4 rounded-xl border border-dashed border-border-strong px-6 py-10">
          <h2 className="text-lg font-medium">No policy decisions yet</h2>
          <p className="max-w-lg text-sm text-text-muted">
            Decisions appear here as soon as a run in this workspace calls a tool. Start a run from
            the home page, then come back.
          </p>
          <Link
            href="/?focus=mission"
            className="inline-flex h-9 items-center rounded-md bg-accent px-4 text-sm font-medium text-accent-fg hover:bg-accent/90"
          >
            Start a run
          </Link>
        </div>
      ) : (
        <>
          <nav aria-label="Filter by decision" className="flex flex-wrap gap-2">
            <FilterLink decision={undefined} active={decision === undefined} count={total} />
            {POLICY_DECISIONS.map((kind) => (
              <FilterLink
                key={kind}
                decision={kind}
                active={decision === kind}
                count={listing.counts[kind]}
              />
            ))}
          </nav>
          {listing.entries.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border-strong px-6 py-8 text-sm text-text-muted">
              No {decision === undefined ? "" : DECISION[decision].label.toLowerCase()} decisions in
              this workspace.
            </p>
          ) : (
            <Entries listing={listing} />
          )}
          {listing.entries.length === AUDIT_PAGE_SIZE ? (
            <p className="text-sm text-text-subtle">Showing the newest {AUDIT_PAGE_SIZE}.</p>
          ) : null}
        </>
      )}
    </div>
  );
}
