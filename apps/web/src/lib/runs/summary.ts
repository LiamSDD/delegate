import type { RunEvent } from "@delegate/runtime";

import { parseAudit } from "./audit";
import { briefStats, parseBrief } from "./brief";
import { buildAgentDeliverables } from "./build-agent";
import { type CitationMetric, costLabel, formatDuration, type RunView } from "./run-view";

type ReadyView = Extract<RunView, { ok: true }>;

export function sourceCount(view: ReadyView, events: readonly RunEvent[]): number | null {
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

export function citationRate(citation: CitationMetric | null): number | null {
  if (citation === null) return null;
  if (citation.kind === "reported") return citation.value;
  return citation.total === 0 ? null : citation.resolved / citation.total;
}

export interface SummaryInput {
  createdAt: string;
  finishedAt: string;
  agents: number;
  sources: number | null;
  citation: CitationMetric | null;
  costMicroUsd: number;
  providers: readonly { provider: string }[];
  models: readonly string[];
}

export interface SummaryItem {
  label: string;
  value: string;
  hint?: string;
}

function percent(rate: number): string {
  return `${String(Math.round(rate * 100))}%`;
}

function citationItem(citation: CitationMetric): SummaryItem | null {
  if (citation.kind === "reported") {
    return {
      label: "citation accuracy",
      value: percent(citation.value),
      ...(citation.checked === null ? {} : { hint: `${String(citation.checked)} claims checked` }),
    };
  }
  if (citation.total === 0) return null;
  return {
    label: "citation accuracy",
    value: percent(citation.resolved / citation.total),
    hint: `${String(citation.resolved)}/${String(citation.total)} citations resolved`,
  };
}

export function summaryItems(input: SummaryInput): SummaryItem[] {
  const items: SummaryItem[] = [
    {
      label: "duration",
      value: formatDuration(Date.parse(input.finishedAt) - Date.parse(input.createdAt)),
    },
    { label: "agents", value: String(input.agents) },
  ];
  if (input.sources !== null) items.push({ label: "sources", value: String(input.sources) });
  const citation = input.citation === null ? null : citationItem(input.citation);
  if (citation !== null) items.push(citation);
  const cost = costLabel(input.costMicroUsd, input.providers);
  items.push({
    label: "cost",
    value: cost.amount,
    ...(cost.note === null ? {} : { hint: cost.note }),
  });
  const models = [...new Set(input.models)];
  if (models.length > 0) items.push({ label: "models", value: models.slice(0, 3).join(" + ") });
  return items;
}
