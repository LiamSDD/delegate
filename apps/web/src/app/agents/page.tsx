import type { Metadata } from "next";
import Link from "next/link";

import { hostOf, passRateLabel } from "@/lib/runs/build-agent";
import { listAssistants } from "@/server/assistants";
import { currentGuest } from "@/server/page-session";

export const metadata: Metadata = { title: "Agents" };

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

export default async function AgentsPage() {
  const guest = await currentGuest();
  const assistants = guest === null ? [] : await listAssistants(guest.app, guest.session);

  return (
    <div className="mx-auto flex max-w-content flex-col gap-10 px-6 pt-16 pb-24 md:pt-24">
      <header className="flex flex-col gap-4">
        <p className="font-mono text-2xs tracking-label text-text-subtle uppercase">Agents</p>
        <h1 className="font-serif text-display-md tracking-display text-balance">
          Assistants you built
        </h1>
        <p className="max-w-xl text-md text-pretty text-text-muted">
          Each assistant answers only from the pages crawled from its company&apos;s site, cites
          every claim and says so when the answer is not there. Built from an Audit with one click
          on “Build it”.
        </p>
        <Link
          href="/agents/playbooks"
          className="self-start text-sm font-medium text-accent hover:underline"
        >
          What the agents learned from past runs
        </Link>
      </header>

      {assistants.length === 0 ? (
        <div className="flex flex-col items-start gap-4 rounded-xl border border-dashed border-border-strong px-6 py-10">
          <h2 className="text-lg font-medium">No assistants yet</h2>
          <p className="max-w-lg text-sm text-text-muted">
            Run an AI Automation Audit on a company URL, then press “Build it” on an opportunity.
            Delegate crawls the site within its robots.txt, indexes it, writes an eval set and
            reports the gaps it found.
          </p>
          <Link
            href="/?focus=mission"
            className="inline-flex h-9 items-center rounded-md bg-accent px-4 text-sm font-medium text-accent-fg hover:bg-accent/90"
          >
            Start an Audit
          </Link>
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
          {assistants.map((assistant) => (
            <li key={assistant.id} className="relative hover:bg-surface-2/60">
              <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:gap-6">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <Link
                    href={`/agents/${assistant.id}`}
                    className="text-md font-medium text-text after:absolute after:inset-0 hover:text-accent"
                  >
                    {assistant.name}
                  </Link>
                  <span className="font-mono text-2xs text-text-subtle">
                    {hostOf(assistant.url)} ·{" "}
                    <time dateTime={assistant.createdAt}>
                      {dateFormat.format(new Date(assistant.createdAt))}
                    </time>{" "}
                    UTC
                  </span>
                </div>
                <div className="flex items-center gap-6 font-mono text-xs text-text-muted tabular">
                  <span>
                    <span className="text-text">{assistant.pages}</span> pages
                  </span>
                  <span>
                    <span className="text-text">{passRateLabel(assistant.passRate)}</span> evals
                  </span>
                  <span
                    className={
                      assistant.status === "ready"
                        ? "rounded-sm bg-success-soft px-1.5 text-2xs text-success"
                        : "rounded-sm bg-warning-soft px-1.5 text-2xs text-warning"
                    }
                  >
                    {assistant.status}
                  </span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
