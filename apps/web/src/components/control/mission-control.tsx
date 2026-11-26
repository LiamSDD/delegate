import Link from "next/link";
import type { ReactNode } from "react";

import { ACTIVE_RUNS_LIMIT } from "@/server/control/active-runs";
import { INBOX_LIMIT } from "@/server/control/inbox";
import { CONTROL_REFRESH_MS, type MissionControl } from "@/server/control/overview";
import { STALE_AFTER_MS } from "@/server/runs";

import { ActiveRunsList } from "./active-runs";
import { ApprovalsInbox } from "./approvals-inbox";
import { AutoRefresh } from "./auto-refresh";
import { plural, utcDateTime } from "./format";
import { AuditLink, RecentDecisions } from "./recent-decisions";
import { SafetySwitches } from "./safety-switches";
import { ControlSection, textLink } from "./section";
import { UsagePanel } from "./usage-panel";

export const CONTROL_TITLE = "Everything running, and what is waiting on you";
export const CONTROL_SUMMARY =
  "Active runs, every approval waiting across them, what the workspace has used, and two switches to hold or stop work. Read from the run log, for this workspace only.";

export const CONTROL_SECTIONS = [
  { id: "approvals", label: "Approvals inbox", title: "Waiting for a decision" },
  { id: "active-runs", label: "Active runs", title: "Running now" },
  { id: "safety", label: "Safety switches", title: "Hold or stop work" },
  { id: "usage", label: "Usage and limits", title: "What this workspace has used" },
  { id: "decisions", label: "Policy decisions", title: "Recent policy decisions" },
] as const;

export function ControlFrame({
  status,
  busy = false,
  children,
}: {
  status: ReactNode;
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      aria-busy={busy ? "true" : undefined}
      className="mx-auto flex max-w-content min-w-0 flex-col gap-10 px-4 pt-16 pb-24 sm:px-6 md:pt-24"
    >
      <header className="flex flex-col gap-4">
        <p className="font-mono text-2xs tracking-label text-text-subtle uppercase">
          Mission Control
        </p>
        <h1 className="font-serif text-display-sm tracking-display text-balance sm:text-display-md">
          {CONTROL_TITLE}
        </h1>
        <p className="max-w-2xl text-md text-text-muted text-pretty">{CONTROL_SUMMARY}</p>
        {status}
      </header>
      {children}
    </div>
  );
}

function activeCount(control: MissionControl): number {
  return control.active.runs.reduce(
    (sum, run) =>
      sum +
      1 +
      run.children.filter((child) => child.status !== "completed" && child.status !== "failed")
        .length,
    0,
  );
}

export function MissionControlView({ control }: { control: MissionControl }) {
  const renderedAt = control.renderedAt.getTime();
  const active = activeCount(control);
  const [approvals, runs, safety, usage, decisions] = CONTROL_SECTIONS;
  return (
    <ControlFrame
      status={
        <AutoRefresh
          renderedAt={control.renderedAt.toISOString()}
          intervalMs={CONTROL_REFRESH_MS}
        />
      }
    >
      {control.hasWorkspace ? null : (
        <p
          role="status"
          className="rounded-lg border border-border bg-surface px-4 py-3 text-sm text-text-muted"
        >
          This browser has no workspace yet, so every section below is empty. A workspace is created
          with your first run.{" "}
          <Link href="/?focus=mission" className={textLink}>
            Start a run
          </Link>
        </p>
      )}
      {control.runsPausedAt === null ? null : (
        <p
          role="status"
          data-paused-banner=""
          className="rounded-lg border border-warning/40 bg-warning-soft px-4 py-3 text-sm text-warning"
        >
          New runs are paused for this workspace since {utcDateTime.format(control.runsPausedAt)}{" "}
          UTC. Nothing new starts until you resume them under{" "}
          <a href={`#${safety.id}`} className="underline underline-offset-4">
            Safety switches
          </a>
          .
        </p>
      )}

      <ControlSection
        id={approvals.id}
        index="01"
        label={approvals.label}
        title={approvals.title}
        aside={
          <p className="font-mono text-2xs text-text-subtle tabular">
            {plural(control.inbox.items.length, "request")} pending
          </p>
        }
      >
        <ApprovalsInbox
          items={control.inbox.items}
          truncated={control.inbox.truncated}
          limit={INBOX_LIMIT}
          renderedAt={renderedAt}
        />
      </ControlSection>

      <ControlSection
        id={runs.id}
        index="02"
        label={runs.label}
        title={runs.title}
        aside={
          <p className="font-mono text-2xs text-text-subtle tabular">
            {plural(active, "run")} active
          </p>
        }
      >
        <ActiveRunsList
          active={control.active}
          renderedAt={renderedAt}
          staleAfterMs={STALE_AFTER_MS}
          limit={ACTIVE_RUNS_LIMIT}
        />
      </ControlSection>

      <ControlSection id={safety.id} index="03" label={safety.label} title={safety.title}>
        <SafetySwitches
          pausedAt={control.runsPausedAt?.toISOString() ?? null}
          activeRuns={active}
          hasWorkspace={control.hasWorkspace}
          activity={control.switchActivity.map((entry) => ({
            id: entry.id,
            action: entry.action,
            at: entry.at.toISOString(),
            runs: entry.runs,
          }))}
        />
      </ControlSection>

      <ControlSection id={usage.id} index="04" label={usage.label} title={usage.title}>
        <UsagePanel usage={control.usage} />
      </ControlSection>

      <ControlSection
        id={decisions.id}
        index="05"
        label={decisions.label}
        title={decisions.title}
        aside={<AuditLink />}
      >
        <RecentDecisions decisions={control.decisions} />
      </ControlSection>
    </ControlFrame>
  );
}

export function MissionControlLoading() {
  return (
    <ControlFrame
      busy
      status={
        <p role="status" className="font-mono text-2xs text-text-subtle">
          Reading the run log…
        </p>
      }
    >
      {CONTROL_SECTIONS.map((section, index) => (
        <ControlSection
          key={section.id}
          id={section.id}
          index={String(index + 1).padStart(2, "0")}
          label={section.label}
          title={section.title}
        >
          <div
            aria-hidden="true"
            className="flex flex-col rounded-xl border border-border bg-surface"
          >
            {[0, 1].map((row) => (
              <div
                key={row}
                className="flex flex-col gap-2 border-b border-border px-4 py-4 last:border-b-0 motion-safe:animate-pulse"
              >
                <span className="h-4 w-32 rounded-sm bg-surface-2" />
                <span className="h-4 w-2/3 rounded-sm bg-surface-2" />
              </div>
            ))}
          </div>
        </ControlSection>
      ))}
    </ControlFrame>
  );
}
