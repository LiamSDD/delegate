"use client";

import type { PlaybookApplied } from "@delegate/runtime";
import Link from "next/link";

import { entryStat, learnedLabel, scopeLabel, sourcesLabel } from "@/lib/runs/playbook";

import { Chip } from "./primitives";

export function PlaybookChip({ applied }: { applied: PlaybookApplied }) {
  return (
    <details
      data-print="hide"
      className="group rounded-lg border border-border bg-surface open:shadow-sm"
    >
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-4 py-2.5 text-sm [&::-webkit-details-marker]:hidden">
        <Chip tone="accent">{learnedLabel(applied.runs)}</Chip>
        <span className="text-text-muted">
          {applied.entries.length} playbook entr{applied.entries.length === 1 ? "y" : "ies"} given
          to the planner
        </span>
        <span className="ml-auto font-mono text-2xs text-text-subtle group-open:hidden">Show</span>
        <span className="ml-auto hidden font-mono text-2xs text-text-subtle group-open:inline">
          Hide
        </span>
      </summary>
      <div className="flex flex-col gap-3 border-t border-border px-4 py-3">
        <p className="text-xs text-pretty text-text-muted">
          Code derived these lessons from the structured outcomes of past runs (plan shapes, cited
          sources, critic results, failures), never from page text. Recorded in this run&apos;s log
          as <code className="font-mono">playbook.applied</code>: {sourcesLabel(applied)}, about{" "}
          {applied.tokens} tokens.
        </p>
        <ul className="flex flex-col gap-2">
          {applied.entries.map((entry) => (
            <li key={entry.id} className="flex min-w-0 flex-col gap-1 sm:flex-row sm:gap-3">
              <span className="flex shrink-0 items-center gap-1.5">
                <Chip tone={entry.polarity === "keep" ? "success" : "warning"}>
                  {entry.polarity}
                </Chip>
                <span className="font-mono text-2xs text-text-subtle">{entry.id}</span>
              </span>
              <span className="min-w-0 text-sm break-words text-text">{entry.text}</span>
              <span className="shrink-0 font-mono text-2xs text-text-subtle tabular sm:ml-auto">
                {entryStat(entry)} · {scopeLabel(entry.scope)}
              </span>
            </li>
          ))}
        </ul>
        <Link
          href="/agents/playbooks"
          className="self-start text-xs font-medium text-accent hover:underline"
        >
          All playbooks and their evolution
        </Link>
      </div>
    </details>
  );
}
