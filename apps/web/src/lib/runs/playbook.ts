import type { PlaybookApplied, PlaybookAppliedEntry } from "@delegate/runtime";

export function learnedLabel(runs: number): string {
  return `Learned from ${runs} past run${runs === 1 ? "" : "s"}`;
}

export function scopeLabel(scope: PlaybookAppliedEntry["scope"]): string {
  return scope === "house" ? "house" : "this workspace";
}

export function sourcesLabel(applied: PlaybookApplied): string {
  return applied.sources
    .map((source) => `${scopeLabel(source.scope)} v${source.version}`)
    .join(" · ");
}

export function entryStat(entry: PlaybookAppliedEntry): string {
  const runs = `${entry.evidence} run${entry.evidence === 1 ? "" : "s"}`;
  return entry.polarity === "keep"
    ? `score ${entry.score.toFixed(2)} · ${runs}`
    : `seen in ${runs}`;
}
