import Link from "next/link";
import type { ReactNode } from "react";

import { missionLabel } from "@/lib/m2-contract";
import { type ClaimChange, summariseClaimDiff } from "@/lib/runs/claim-diff";
import type { RunMetrics } from "@/lib/runs/compare";
import { formatDuration, formatTokens } from "@/lib/runs/run-view";
import { cn } from "@/lib/utils";

import { Chip, type Tone } from "./primitives";

interface MetricRow {
  label: string;
  a: string;
  b: string;
  delta: { text: string; tone: Tone } | null;
}

function percent(rate: number | null): string {
  return rate === null ? "n/a" : `${String(Math.round(rate * 100))}%`;
}

function signed(value: number, format: (n: number) => string): string {
  if (value === 0) return "same";
  return `${value > 0 ? "+" : "−"}${format(Math.abs(value))}`;
}

function numericDelta(
  a: number | null,
  b: number | null,
  format: (n: number) => string,
  better: "higher" | "lower" | null,
): MetricRow["delta"] {
  if (a === null || b === null) return null;
  const diff = b - a;
  const tone: Tone =
    diff === 0 || better === null
      ? "neutral"
      : (better === "higher") === diff > 0
        ? "success"
        : "warning";
  return { text: signed(diff, format), tone };
}

function metricRows(a: RunMetrics, b: RunMetrics): MetricRow[] {
  return [
    {
      label: "Outcome",
      a: a.outcome ?? "running",
      b: b.outcome ?? "running",
      delta: null,
    },
    {
      label: "Duration",
      a: a.durationMs === null ? "in progress" : formatDuration(a.durationMs),
      b: b.durationMs === null ? "in progress" : formatDuration(b.durationMs),
      delta: numericDelta(a.durationMs, b.durationMs, formatDuration, "lower"),
    },
    {
      label: "Steps done",
      a: `${String(a.stepsDone)}/${String(a.stepsTotal)}`,
      b: `${String(b.stepsDone)}/${String(b.stepsTotal)}`,
      delta: numericDelta(a.stepsDone, b.stepsDone, String, "higher"),
    },
    {
      label: "Tokens in / out",
      a: `${formatTokens(a.inputTokens)} / ${formatTokens(a.outputTokens)}`,
      b: `${formatTokens(b.inputTokens)} / ${formatTokens(b.outputTokens)}`,
      delta: numericDelta(
        a.inputTokens + a.outputTokens,
        b.inputTokens + b.outputTokens,
        formatTokens,
        "lower",
      ),
    },
    {
      label: "Citation accuracy",
      a: percent(a.citationAccuracy),
      b: percent(b.citationAccuracy),
      delta: numericDelta(
        a.citationAccuracy === null ? null : Math.round(a.citationAccuracy * 100),
        b.citationAccuracy === null ? null : Math.round(b.citationAccuracy * 100),
        (n) => `${String(n)} pts`,
        "higher",
      ),
    },
    {
      label: "Sources",
      a: a.sources === null ? "n/a" : String(a.sources),
      b: b.sources === null ? "n/a" : String(b.sources),
      delta: numericDelta(a.sources, b.sources, String, "higher"),
    },
    {
      label: "Models",
      a: a.models.length === 0 ? "none" : a.models.join(", "),
      b: b.models.length === 0 ? "none" : b.models.join(", "),
      delta: null,
    },
  ];
}

function RunHeading({ side, run }: { side: "A" | "B"; run: RunMetrics }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="font-mono text-2xs tracking-label text-text-subtle uppercase">
        Run {side}
      </span>
      <Link
        href={`/runs/${run.runId}`}
        className="truncate font-mono text-sm text-text underline decoration-border-strong underline-offset-4 hover:text-accent hover:decoration-accent"
      >
        {run.target ?? run.runId.slice(0, 8)} · {run.runId.slice(0, 8)}
      </Link>
      <span className="flex flex-wrap gap-1.5">
        <Chip>{missionLabel(run.missionId)}</Chip>
        {run.execution === "simulated" ? <Chip tone="warning">Simulated</Chip> : null}
        {run.fork === null ? null : (
          <Chip tone="accent">Fork of {run.fork.parentRunId.slice(0, 8)}</Chip>
        )}
      </span>
    </div>
  );
}

function MetricsTable({ a, b }: { a: RunMetrics; b: RunMetrics }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
      <table className="w-full table-fixed text-left text-sm">
        <caption className="sr-only">Metrics of run A and run B side by side</caption>
        <thead className="border-b border-border">
          <tr className="font-mono text-2xs tracking-label text-text-subtle uppercase">
            <th scope="col" className="w-[28%] px-3 py-3 font-normal md:px-4">
              Metric
            </th>
            <th scope="col" className="px-3 py-3 font-normal md:px-4">
              Run A
            </th>
            <th scope="col" className="px-3 py-3 font-normal md:px-4">
              Run B
            </th>
          </tr>
        </thead>
        <tbody>
          {metricRows(a, b).map((row) => (
            <tr key={row.label} className="border-b border-border align-top last:border-b-0">
              <th scope="row" className="px-3 py-3 font-normal text-text-muted md:px-4">
                {row.label}
              </th>
              <td className="px-3 py-3 font-mono text-xs break-words text-text tabular md:px-4 md:text-sm">
                {row.a}
              </td>
              <td className="px-3 py-3 font-mono text-xs break-words text-text tabular md:px-4 md:text-sm">
                <span className="flex flex-wrap items-center gap-1.5">
                  {row.b}
                  {row.delta === null ? null : <Chip tone={row.delta.tone}>{row.delta.text}</Chip>}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const KIND_STYLE: Record<ClaimChange["kind"], { label: string; tone: Tone; rail: string }> = {
  added: { label: "Added", tone: "success", rail: "border-l-success" },
  removed: { label: "Removed", tone: "danger", rail: "border-l-danger" },
  changed: { label: "Changed", tone: "warning", rail: "border-l-warning" },
  unchanged: { label: "Same", tone: "neutral", rail: "border-l-border" },
};

function ClaimText({
  label,
  text,
  muted,
}: {
  label?: string | null | undefined;
  text: string;
  muted?: boolean;
}) {
  return (
    <p className={cn("text-sm text-pretty", muted === true ? "text-text-muted" : "text-text")}>
      {label === undefined || label === null ? null : (
        <span className="mr-1.5 font-mono text-2xs text-text-subtle">{label}</span>
      )}
      {text}
    </p>
  );
}

function ClaimRow({ change }: { change: ClaimChange }) {
  const style = KIND_STYLE[change.kind];
  return (
    <li className={cn("flex flex-col gap-1.5 border-l-2 py-2 pl-3", style.rail)}>
      <span className="flex items-center gap-2">
        <Chip tone={style.tone}>{style.label}</Chip>
        {change.kind === "changed" ? (
          <span className="font-mono text-2xs text-text-subtle">
            {Math.round(change.similarity * 100)}% similar
          </span>
        ) : null}
      </span>
      {change.kind === "added" ? <ClaimText label={change.b.label} text={change.b.text} /> : null}
      {change.kind === "removed" ? (
        <ClaimText label={change.a.label} text={change.a.text} muted />
      ) : null}
      {change.kind === "changed" ? (
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-2xs text-text-subtle">A</span>
            <ClaimText label={change.a.label} text={change.a.text} muted />
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-2xs text-text-subtle">B</span>
            <ClaimText label={change.b.label} text={change.b.text} />
          </div>
        </div>
      ) : null}
      {change.kind === "unchanged" ? (
        <ClaimText label={change.b.label} text={change.b.text} muted />
      ) : null}
    </li>
  );
}

function ClaimDiff({ changes }: { changes: ClaimChange[] | null }) {
  if (changes === null)
    return (
      <p className="rounded-lg border border-dashed border-border-strong px-4 py-6 text-sm text-text-muted">
        One of the runs has no readable brief or audit, so there are no claims to compare.
      </p>
    );
  const summary = summariseClaimDiff(changes);
  const sections = [...new Set(changes.map((change) => change.section))];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        <Chip tone="success">+{summary.added} added</Chip>
        <Chip tone="danger">−{summary.removed} removed</Chip>
        <Chip tone="warning">~{summary.changed} changed</Chip>
        <Chip>={summary.unchanged} same</Chip>
      </div>
      {changes.length === 0 ? (
        <p className="text-sm text-text-muted">Neither run has any claims.</p>
      ) : (
        sections.map((section) => {
          const inSection = changes.filter((change) => change.section === section);
          const differing = inSection.filter((change) => change.kind !== "unchanged");
          const same = inSection.filter((change) => change.kind === "unchanged");
          return (
            <section
              key={section}
              aria-label={section}
              className="flex flex-col gap-2 rounded-lg border border-border bg-surface px-4 py-3"
            >
              <h3 className="text-sm font-medium text-text">{section}</h3>
              {differing.length === 0 ? (
                <p className="text-xs text-text-subtle">No differences in this section.</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {differing.map((change, index) => (
                    <ClaimRow key={`${change.kind}-${String(index)}`} change={change} />
                  ))}
                </ul>
              )}
              {same.length === 0 ? null : (
                <details className="group">
                  <summary className="cursor-pointer font-mono text-2xs text-text-subtle hover:text-text">
                    {same.length} unchanged claim{same.length === 1 ? "" : "s"}
                  </summary>
                  <ul className="mt-1 flex flex-col gap-1">
                    {same.map((change, index) => (
                      <ClaimRow key={`same-${String(index)}`} change={change} />
                    ))}
                  </ul>
                </details>
              )}
            </section>
          );
        })
      )}
    </div>
  );
}

export function CompareShell({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-8 px-4 pt-10 pb-24 md:px-6 md:pt-16">
      {children}
    </div>
  );
}

export function CompareView({
  a,
  b,
  claims,
  sameMission,
}: {
  a: RunMetrics;
  b: RunMetrics;
  claims: ClaimChange[] | null;
  sameMission: boolean;
}) {
  return (
    <CompareShell>
      <header className="flex flex-col gap-4">
        <p className="font-mono text-2xs tracking-label text-text-subtle uppercase">Run compare</p>
        <h1 className="font-serif text-display-sm tracking-display text-balance">
          {a.target ?? "Run A"} <span className="text-text-subtle">vs</span> {b.target ?? "Run B"}
        </h1>
        <p className="max-w-2xl text-md text-text-muted text-pretty">
          Both columns are rebuilt from each run’s event log. Claims are matched within a section:
          identical text is the same claim, the closest remaining pair with at least half of its
          words in common is a change, the rest were added or removed.
        </p>
        {sameMission ? null : (
          <p role="note" className="text-sm text-warning">
            These runs are different missions, so the comparison is only indicative.
          </p>
        )}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <RunHeading side="A" run={a} />
          <RunHeading side="B" run={b} />
        </div>
      </header>
      <MetricsTable a={a} b={b} />
      <section aria-labelledby="claim-diff" className="flex flex-col gap-3">
        <h2 id="claim-diff" className="text-lg font-medium">
          Claim diff, A → B
        </h2>
        <ClaimDiff changes={claims} />
      </section>
    </CompareShell>
  );
}

export function CompareMessage({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <CompareShell>
      <p className="font-mono text-2xs tracking-label text-text-subtle uppercase">{eyebrow}</p>
      <h1 className="font-serif text-display-sm tracking-display">{title}</h1>
      <div className="max-w-xl text-md text-text-muted">{children}</div>
      <div className="flex gap-3">
        <Link
          href="/runs"
          className="inline-flex h-9 items-center rounded-md bg-accent px-4 text-sm font-medium text-accent-fg hover:bg-accent/90"
        >
          Your runs
        </Link>
      </div>
    </CompareShell>
  );
}
