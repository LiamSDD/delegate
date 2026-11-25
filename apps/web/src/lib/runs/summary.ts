import { type CitationMetric, costLabel, formatDuration } from "./run-view";

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
