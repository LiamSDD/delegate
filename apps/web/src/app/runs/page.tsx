import type { Metadata } from "next";
import Link from "next/link";

import { missionLabel } from "@/lib/m2-contract";
import { formatDuration } from "@/lib/runs/run-view";
import { apiDeps } from "@/server/deps";
import { reviveOrSweep } from "@/server/durable";
import { currentGuest } from "@/server/page-session";
import { getRunRecord, listOpenRuns, listRuns, type RunListItem } from "@/server/runs";

export const metadata: Metadata = { title: "Runs" };

const STATUS: Record<RunListItem["status"], { label: string; className: string }> = {
  planning: { label: "Planning", className: "bg-accent-soft text-accent" },
  awaiting_plan_approval: { label: "Plan ready", className: "bg-accent-soft text-accent" },
  running: { label: "Running", className: "bg-accent-soft text-accent" },
  awaiting_approval: { label: "Needs approval", className: "bg-warning-soft text-warning" },
  completed: { label: "Completed", className: "bg-success-soft text-success" },
  failed: { label: "Failed", className: "bg-danger-soft text-danger" },
};

const MISSION_TONE: Record<string, string> = {
  "company-xray": "border-border bg-surface-2 text-text-muted",
  "automation-audit": "border-transparent bg-accent-soft text-accent",
  "build-agent": "border-transparent bg-success-soft text-success",
};

function duration(run: RunListItem): string {
  if (run.finishedAt === null) return "in progress";
  return formatDuration(run.finishedAt.getTime() - run.createdAt.getTime());
}

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

export default async function RunsPage() {
  const guest = await currentGuest();
  if (guest !== null) {
    const deps = apiDeps();
    for (const id of await listOpenRuns(guest.app, guest.session)) {
      const record = await getRunRecord(guest.app, guest.session.userId, id);
      if (record !== null) await reviveOrSweep(guest.app, guest.session.userId, record, deps);
    }
  }
  const runs = guest === null ? [] : await listRuns(guest.app, guest.session);

  return (
    <div className="mx-auto flex max-w-content flex-col gap-10 px-6 pt-16 pb-24 md:pt-24">
      <header className="flex flex-col gap-4">
        <p className="font-mono text-2xs tracking-label text-text-subtle uppercase">Runs</p>
        <h1 className="font-serif text-display-md tracking-display text-balance">
          Your recent runs
        </h1>
        <p className="max-w-xl text-md text-text-muted text-pretty">
          Runs started from this browser. Each one replays from its event log. Demo runs are deleted
          after 7 days.
        </p>
      </header>

      {runs.length === 0 ? (
        <div className="flex flex-col items-start gap-4 rounded-xl border border-dashed border-border-strong px-6 py-10">
          <h2 className="text-lg font-medium">No runs yet</h2>
          <p className="max-w-lg text-sm text-text-muted">
            Paste a company URL, a GitHub repository or a goal on the home page to start a run.
          </p>
          <Link
            href="/?focus=mission"
            className="inline-flex h-9 items-center rounded-md bg-accent px-4 text-sm font-medium text-accent-fg hover:bg-accent/90"
          >
            Start a run
          </Link>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-surface shadow-sm">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <caption className="sr-only">Recent runs, newest first</caption>
            <thead className="border-b border-border">
              <tr className="font-mono text-2xs tracking-label text-text-subtle uppercase">
                <th scope="col" className="px-4 py-3 font-normal">
                  Target
                </th>
                <th scope="col" className="px-4 py-3 font-normal">
                  Mission
                </th>
                <th scope="col" className="px-4 py-3 font-normal">
                  Status
                </th>
                <th scope="col" className="px-4 py-3 font-normal">
                  Duration
                </th>
                <th scope="col" className="px-4 py-3 font-normal">
                  Created (UTC)
                </th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const status = STATUS[run.status];
                return (
                  <tr
                    key={run.id}
                    className="border-b border-border last:border-b-0 hover:bg-surface-2/60"
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={`/runs/${run.id}`}
                        className="font-mono text-sm text-text underline decoration-border-strong underline-offset-4 hover:text-accent hover:decoration-accent"
                      >
                        {run.target ?? run.id.slice(0, 8)}
                      </Link>
                      {run.execution === "simulated" ? (
                        <span className="ml-2 rounded-sm bg-warning-soft px-1.5 font-mono text-2xs text-warning">
                          Simulated
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex h-5 items-center rounded-sm border px-1.5 font-mono text-2xs ${MISSION_TONE[run.mission] ?? "border-border text-text-muted"}`}
                      >
                        {missionLabel(run.mission)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex h-5 items-center rounded-sm px-1.5 font-mono text-2xs ${status.className}`}
                      >
                        {status.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-text-muted tabular">
                      {duration(run)}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-text-muted tabular">
                      <time dateTime={run.createdAt.toISOString()}>
                        {dateFormat.format(run.createdAt)}
                      </time>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
