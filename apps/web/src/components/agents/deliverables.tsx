"use client";

import {
  ArrowUpRight,
  CircleCheck,
  CircleSlash,
  CircleX,
  Clock3,
  MessagesSquare,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import {
  type AssistantArtifact,
  type AssistantEvals,
  type CitationRef,
  gapSeverity,
  type GapSeverity,
  type GapsReport,
  sortGapsBySeverity,
} from "@/lib/m3-contract";
import { evalRows, hostOf, passRateLabel } from "@/lib/runs/build-agent";
import { cn } from "@/lib/utils";

import { Chip, Eyebrow, primaryButton, type Tone } from "../run/primitives";

export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="font-mono text-lg leading-7 font-medium text-text tabular">{value}</span>
      <span className="font-mono text-2xs text-text-subtle">
        {label}
        {hint === undefined ? null : <span className="text-text-subtle/80"> · {hint}</span>}
      </span>
    </div>
  );
}

export function corpusSummary(stats: AssistantArtifact["corpusStats"]) {
  return [
    { label: "pages", value: String(stats.pages) },
    { label: "chunks", value: String(stats.chunks) },
    {
      label: "embedded",
      value:
        stats.chunks === 0 ? "0" : `${Math.round((stats.embeddedChunks / stats.chunks) * 100)}%`,
    },
  ];
}

export function AssistantCard({
  assistant,
  passRate,
  open = true,
}: {
  assistant: AssistantArtifact;
  passRate: number | null | undefined;
  open?: boolean;
}) {
  return (
    <article className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4 shadow-sm md:p-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <Eyebrow>Assistant · {hostOf(assistant.url)}</Eyebrow>
          <h3 className="font-serif text-xl tracking-display text-pretty text-text">
            {assistant.name}
          </h3>
          <p className="text-sm leading-6 text-pretty text-text-muted">{assistant.goal}</p>
        </div>
        <Chip tone={assistant.status === "ready" ? "success" : "warning"}>
          {assistant.status === "ready" ? "ready" : "draft"}
        </Chip>
      </header>
      <div className="flex flex-wrap gap-x-8 gap-y-3 border-t border-border pt-4">
        {corpusSummary(assistant.corpusStats).map((item) => (
          <Stat key={item.label} label={item.label} value={item.value} />
        ))}
        <Stat label="retrieval" value={assistant.retrieval.mode} />
        <Stat label="eval pass rate" value={passRateLabel(passRate ?? assistant.passRate)} />
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Eyebrow>Covers</Eyebrow>
          <ul className="flex list-disc flex-col gap-1 pl-4 text-sm text-text marker:text-accent">
            {assistant.scope.covers.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
        {assistant.scope.excludes.length === 0 ? null : (
          <div className="flex flex-col gap-1.5">
            <Eyebrow>Declines</Eyebrow>
            <ul className="flex list-disc flex-col gap-1 pl-4 text-sm text-text-muted marker:text-text-subtle">
              {assistant.scope.excludes.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <Eyebrow>Starter questions</Eyebrow>
        <ul className="flex flex-wrap gap-1.5">
          {assistant.starterQuestions.map((question) => (
            <li
              key={question}
              className="rounded-md border border-border bg-surface-2/60 px-2 py-1 text-xs text-text"
            >
              {question}
            </li>
          ))}
        </ul>
      </div>
      {open ? (
        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
          <Link href={`/agents/${assistant.id}`} className={primaryButton}>
            <MessagesSquare className="size-3.5" aria-hidden="true" />
            Open assistant
          </Link>
          <span className="font-mono text-2xs text-text-subtle">
            Cited chat · embed snippet · evals · gaps
          </span>
        </div>
      ) : null}
    </article>
  );
}

const VERDICT: Record<"pass" | "fail" | "pending", { tone: Tone; label: string }> = {
  pass: { tone: "success", label: "pass" },
  fail: { tone: "danger", label: "fail" },
  pending: { tone: "neutral", label: "pending" },
};

function VerdictIcon({ verdict }: { verdict: "pass" | "fail" | "pending" }) {
  const Icon = verdict === "pass" ? CircleCheck : verdict === "fail" ? CircleX : Clock3;
  return (
    <Icon
      aria-hidden="true"
      className={cn(
        "mt-0.5 size-4 shrink-0",
        verdict === "pass" && "text-success",
        verdict === "fail" && "text-danger",
        verdict === "pending" && "text-text-subtle",
      )}
    />
  );
}

export function CitationLinks({ citations }: { citations: readonly CitationRef[] }) {
  if (citations.length === 0) return null;
  return (
    <ol className="flex flex-col gap-1">
      {citations.map((citation, index) => (
        <li key={`${citation.chunkId}-${String(index)}`} className="flex gap-2 text-xs">
          <span className="w-4 shrink-0 font-mono text-text-subtle tabular">{index + 1}</span>
          <a
            href={citation.url}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="min-w-0 truncate text-text-muted underline decoration-border-strong underline-offset-4 hover:text-accent"
          >
            {citation.title ?? citation.url}
          </a>
        </li>
      ))}
    </ol>
  );
}

export function EvalResults({
  evals,
  running,
}: {
  evals: AssistantEvals | null;
  running: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);
  if (evals === null) {
    return (
      <div className="rounded-lg border border-dashed border-border px-4 py-5 text-sm text-text-muted">
        {running
          ? "The eval set is generated from the crawled pages, then every case is asked and graded."
          : "This run produced no eval results."}
      </div>
    );
  }
  const rows = evalRows(evals);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-x-8 gap-y-2 rounded-xl border border-border bg-surface p-4">
        <div className="flex flex-col">
          <Eyebrow>Eval pass rate</Eyebrow>
          <span className="font-mono text-display-sm leading-10 font-medium text-text tabular">
            {passRateLabel(evals.passRate)}
          </span>
        </div>
        <div className="flex flex-col pb-1 font-mono text-2xs text-text-subtle">
          <span>
            {evals.passed}/{evals.total} cases passed
          </span>
          {evals.grader === undefined ? null : (
            <span>
              graded by {evals.grader.model} · {evals.grader.provider}
            </span>
          )}
        </div>
        {evals.note === undefined ? null : (
          <p className="w-full text-xs text-text-muted">{evals.note}</p>
        )}
      </div>
      <ul className="flex flex-col divide-y divide-border rounded-xl border border-border bg-surface">
        {rows.map((row) => {
          const expanded = open === row.id;
          return (
            <li key={row.id}>
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => {
                  setOpen(expanded ? null : row.id);
                }}
                className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-surface-2/50"
              >
                <VerdictIcon verdict={row.verdict} />
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="text-sm text-text">{row.question}</span>
                  <span className="flex flex-wrap gap-1.5">
                    <Chip tone={VERDICT[row.verdict].tone}>{VERDICT[row.verdict].label}</Chip>
                    <Chip>{row.answerable ? "answerable" : "should refuse"}</Chip>
                    {row.refused ? <Chip tone="warning">refused</Chip> : null}
                    {row.citations.length > 0 ? (
                      <Chip>
                        {row.citations.length} citation{row.citations.length === 1 ? "" : "s"}
                      </Chip>
                    ) : null}
                  </span>
                </span>
              </button>
              {expanded ? (
                <div className="flex flex-col gap-3 border-t border-border bg-bg/40 px-4 py-3 pl-11">
                  {row.answer === null ? null : (
                    <div className="flex flex-col gap-1">
                      <Eyebrow>Answer</Eyebrow>
                      <p className="text-sm leading-6 whitespace-pre-wrap text-text">
                        {row.answer}
                      </p>
                    </div>
                  )}
                  <CitationLinks citations={row.citations} />
                  {row.expectedAnswer === "" ? null : (
                    <div className="flex flex-col gap-1">
                      <Eyebrow>Expected</Eyebrow>
                      <p className="text-sm text-text-muted">{row.expectedAnswer}</p>
                    </div>
                  )}
                  {row.reason === null ? null : (
                    <p className="font-mono text-2xs text-text-subtle">Grader: {row.reason}</p>
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const SEVERITY_TONE: Record<GapSeverity, Tone> = {
  high: "danger",
  medium: "warning",
  low: "neutral",
};

const KIND_LABEL: Record<string, string> = {
  unanswerable: "unanswerable",
  thin_coverage: "thin coverage",
  contradiction: "contradiction",
  failed_eval: "failed eval",
};

export function GapsList({ gaps, running }: { gaps: GapsReport | null; running: boolean }) {
  if (gaps === null) {
    return (
      <div className="rounded-lg border border-dashed border-border px-4 py-5 text-sm text-text-muted">
        {running
          ? "Gaps appear once the assistant has been evaluated against the site."
          : "This run produced no gaps report."}
      </div>
    );
  }
  const sorted = sortGapsBySeverity(gaps.gaps);
  return (
    <div className="flex flex-col gap-3">
      <p className="font-mono text-2xs text-text-subtle">
        Coverage{" "}
        {gaps.coverage.ratio === null ? "n/a" : `${String(Math.round(gaps.coverage.ratio * 100))}%`}{" "}
        · {gaps.coverage.topicsCovered}/{gaps.coverage.topicsTotal} topics · {gaps.coverage.pages}{" "}
        pages
      </p>
      {sorted.length === 0 ? (
        <p className="flex items-center gap-2 rounded-lg border border-border bg-surface px-4 py-3 text-sm text-text-muted">
          <CircleSlash className="size-4 text-text-subtle" aria-hidden="true" />
          No gaps found in the evaluated topics.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {sorted.map((gap) => {
            const severity = gapSeverity(gap.kind);
            return (
              <li
                key={gap.id}
                className="flex flex-col gap-1.5 rounded-xl border border-border bg-surface px-4 py-3"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <Chip tone={SEVERITY_TONE[severity]}>{severity}</Chip>
                  <Chip>{KIND_LABEL[gap.kind] ?? gap.kind}</Chip>
                </div>
                <p className="text-sm font-medium text-text">{gap.topic}</p>
                <p className="text-sm leading-6 text-text-muted">{gap.detail}</p>
                {gap.suggestion === "" ? null : (
                  <p className="text-xs text-text">
                    <span className="text-text-subtle">Suggested fix: </span>
                    {gap.suggestion}
                  </p>
                )}
                {gap.evidence.length === 0 ? null : (
                  <div className="flex flex-wrap gap-2 pt-1">
                    {gap.evidence.map((citation) => (
                      <a
                        key={citation.chunkId}
                        href={citation.url}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        className="inline-flex items-center gap-1 font-mono text-2xs text-text-muted hover:text-accent"
                      >
                        {citation.title ?? hostOf(citation.url)}
                        <ArrowUpRight className="size-3" aria-hidden="true" />
                      </a>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
