"use client";

import type { RunEvent } from "@delegate/runtime";

import { parseAudit } from "@/lib/runs/audit";
import { briefStats, parseBrief } from "@/lib/runs/brief";
import { buildAgentDeliverables } from "@/lib/runs/build-agent";
import type { RunView } from "@/lib/runs/run-view";
import { summaryItems } from "@/lib/runs/summary";

import { Eyebrow } from "./primitives";

type ReadyView = Extract<RunView, { ok: true }>;

function sourceCount(view: ReadyView, events: readonly RunEvent[]): number | null {
  if (view.audit?.content !== undefined && view.audit.content !== null) {
    const parsed = parseAudit(view.audit.content);
    if (parsed.ok) return parsed.audit.sources.length;
  }
  if (view.brief?.content !== undefined && view.brief.content !== null) {
    const parsed = parseBrief(view.brief.content);
    if (parsed.ok) return briefStats(parsed.brief).sources;
  }
  if (view.missionId === "build-agent") {
    return buildAgentDeliverables(events).assistant?.corpusStats.pages ?? null;
  }
  return null;
}

export function SummaryStrip({ view, events }: { view: ReadyView; events: readonly RunEvent[] }) {
  if (view.outcome?.kind !== "completed" || view.finishedAt === null) return null;
  const items = summaryItems({
    createdAt: view.createdAt,
    finishedAt: view.finishedAt,
    agents: view.lanes.length,
    sources: sourceCount(view, events),
    citation: view.citation,
    costMicroUsd: view.usage.costMicroUsd,
    providers: view.providers,
    models: view.modelMix.map((entry) => entry.model),
  });
  return (
    <section
      aria-label="What Delegate did"
      className="flex flex-col gap-2 rounded-lg border border-border bg-surface px-4 py-3 md:flex-row md:items-center md:gap-6"
    >
      <Eyebrow className="shrink-0">What Delegate did</Eyebrow>
      <dl className="flex flex-wrap gap-x-6 gap-y-2">
        {items.map((item) => (
          <div key={item.label} className="flex min-w-0 items-baseline gap-1.5">
            <dt className="font-mono text-2xs text-text-subtle">{item.label}</dt>
            <dd className="truncate font-mono text-sm font-medium text-text tabular">
              {item.value}
              {item.hint === undefined ? null : (
                <span className="ml-1 text-2xs font-normal text-text-subtle">{item.hint}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
