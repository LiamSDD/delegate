"use client";

import { ArrowLeft, GitFork, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { Chip, Eyebrow, useNow } from "@/components/run/primitives";
import { useRunStream } from "@/components/run/use-run-stream";
import { missionLabel } from "@/lib/m2-contract";
import { costLabel, formatDuration, formatTokens } from "@/lib/runs/run-view";
import { buildTrace, type SpanKind, type TraceSpan } from "@/lib/runs/trace";
import { cn } from "@/lib/utils";

const KIND_STYLE: Record<SpanKind, { bar: string; dot: string; label: string }> = {
  run: { bar: "bg-text-subtle/50", dot: "bg-text-subtle", label: "run" },
  step: { bar: "bg-accent/35", dot: "bg-accent", label: "step" },
  agent: { bar: "bg-accent/70", dot: "bg-accent", label: "agent" },
  model: { bar: "bg-success/70", dot: "bg-success", label: "model call" },
  tool: { bar: "bg-text-muted/60", dot: "bg-text-muted", label: "tool call" },
  policy: { bar: "bg-success", dot: "bg-success", label: "policy" },
  critic: { bar: "bg-warning", dot: "bg-warning", label: "critic" },
};

function spanTone(span: TraceSpan): string {
  if (span.status === "error" || span.status === "denied") return "bg-danger";
  if (span.status === "flagged") return "bg-warning";
  return KIND_STYLE[span.kind].bar;
}

function ticks(durationMs: number): number[] {
  return [0, 0.25, 0.5, 0.75, 1].map((fraction) => fraction * durationMs);
}

function Detail({ label, value }: { label: string; value: string | number | undefined }) {
  if (value === undefined) return null;
  return (
    <div className="flex justify-between gap-4 border-b border-border py-1.5 last:border-b-0">
      <dt className="text-text-muted">{label}</dt>
      <dd className="text-right font-mono text-text tabular">{value}</dd>
    </div>
  );
}

function SpanDrawer({ span, onClose }: { span: TraceSpan; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  const instant = span.startMs === span.endMs;
  const { attrs } = span;
  return (
    <aside
      role="dialog"
      aria-modal="false"
      aria-labelledby="span-title"
      className="fixed inset-x-0 bottom-0 z-40 flex max-h-[75dvh] flex-col border-t border-border-strong bg-surface shadow-lg motion-safe:animate-card-in md:inset-x-auto md:top-14 md:right-0 md:bottom-0 md:max-h-none md:w-[26rem] md:border-t-0 md:border-l"
    >
      <div className="flex items-start gap-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Eyebrow>{KIND_STYLE[span.kind].label}</Eyebrow>
          <h2 id="span-title" className="font-mono text-sm break-words text-text">
            {span.name}
          </h2>
        </div>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close span details"
          className="flex size-8 items-center justify-center rounded-md text-text-muted hover:bg-surface-2 hover:text-text"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
      <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-4 py-4">
        <dl className="text-xs">
          <Detail label="Status" value={span.status} />
          <Detail label="Start" value={`+${formatDuration(span.startMs)}`} />
          <Detail
            label={instant ? "Instant" : "Latency"}
            value={instant ? "decision" : formatDuration(span.endMs - span.startMs)}
          />
          <Detail label="Provider" value={attrs.provider} />
          <Detail label="Model" value={attrs.model} />
          <Detail label="Role" value={attrs.role} />
          <Detail label="Model role" value={attrs.modelRole} />
          <Detail label="Tool" value={attrs.tool} />
          <Detail label="Policy" value={attrs.policyId} />
          <Detail label="Decision" value={attrs.decision} />
          <Detail label="Severity" value={attrs.severity} />
          <Detail label="Category" value={attrs.category} />
          <Detail
            label="Tokens in / out"
            value={
              attrs.inputTokens === undefined
                ? undefined
                : `${formatTokens(attrs.inputTokens)} / ${formatTokens(attrs.outputTokens ?? 0)}`
            }
          />
          <Detail
            label="Cached"
            value={
              attrs.cacheReadTokens === undefined ? undefined : formatTokens(attrs.cacheReadTokens)
            }
          />
          <Detail
            label="Cost"
            value={
              attrs.costMicroUsd === undefined
                ? undefined
                : costLabel(attrs.costMicroUsd, []).amount
            }
          />
        </dl>
        {attrs.inferredStart === true ? (
          <p className="text-2xs text-text-subtle">
            Model-call start is inferred from the previous event in the same lane; the end is when
            usage was reported.
          </p>
        ) : null}
        <section className="flex flex-col gap-1.5">
          <Eyebrow>Input summary</Eyebrow>
          <p className="rounded-md border border-border bg-bg px-2.5 py-2 font-mono text-xs break-words whitespace-pre-wrap text-text">
            {span.input ?? "Not recorded for this span."}
          </p>
        </section>
        <section className="flex flex-col gap-1.5">
          <Eyebrow>Output summary</Eyebrow>
          <p className="rounded-md border border-border bg-bg px-2.5 py-2 font-mono text-xs break-words whitespace-pre-wrap text-text">
            {span.output ?? "Not recorded for this span."}
          </p>
        </section>
        <p className="text-2xs text-text-subtle">
          Summaries come from the run&apos;s event log, which stores redacted summaries only. Raw
          page text and prompts are never written to events.
        </p>
      </div>
      <div className="flex items-center gap-3 border-t border-border px-4 py-3">
        <button
          type="button"
          disabled
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-sm font-medium text-text opacity-60"
        >
          <GitFork className="size-3.5" aria-hidden="true" />
          Fork from here
        </button>
        <span className="font-mono text-2xs text-text-subtle">Arrives in M4</span>
      </div>
    </aside>
  );
}

export function TraceView({
  runId,
  target,
  missionId,
}: {
  runId: string;
  target: string | null;
  missionId: string;
}) {
  const { events, stream } = useRunStream(runId);
  const terminal = events.some(
    (event) => event.type === "run.completed" || event.type === "run.failed",
  );
  const now = useNow(!terminal && events.length > 0, 500);
  const trace = useMemo(() => buildTrace(events, now), [events, now]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = trace.spans.find((span) => span.id === selectedId) ?? null;
  const duration = Math.max(trace.durationMs, 1);
  const run = trace.spans[0];
  const models = [
    ...new Set(
      trace.spans.flatMap((span) =>
        span.kind === "model" && span.attrs.model !== undefined ? [span.attrs.model] : [],
      ),
    ),
  ];

  if (stream.phase === "not_found") {
    return (
      <div className="mx-auto flex max-w-content flex-col gap-4 px-6 pt-16 pb-24">
        <Eyebrow>Trace · 404</Eyebrow>
        <h1 className="font-serif text-display-sm tracking-display">This run is not available</h1>
        <Link href="/runs" className="text-sm text-accent underline underline-offset-4">
          Your runs
        </Link>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col", selected !== null && "md:pr-[26rem]")}>
      <div className="border-b border-border">
        <div className="mx-auto flex max-w-[96rem] flex-col gap-4 px-4 py-4 md:px-6">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Link
              href={`/runs/${runId}`}
              className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text"
            >
              <ArrowLeft className="size-3.5" aria-hidden="true" />
              Run
            </Link>
            <span aria-hidden="true" className="text-text-subtle">
              /
            </span>
            <Eyebrow>{missionLabel(missionId)}</Eyebrow>
            <h1 className="font-mono text-base font-medium text-text">
              {target ?? "run"} <span className="text-text-subtle">· trace</span>
            </h1>
            {terminal ? null : (
              <Chip tone="accent">
                <span
                  aria-hidden="true"
                  className="size-1.5 rounded-full bg-current motion-safe:animate-pulse"
                />
                live
              </Chip>
            )}
          </div>
          <dl className="flex flex-wrap gap-x-8 gap-y-2 font-mono text-sm tabular">
            {[
              ["Duration", formatDuration(trace.durationMs)],
              ["Spans", String(trace.spans.length)],
              [
                "Tokens in / out",
                `${formatTokens(run?.attrs.inputTokens ?? 0)} / ${formatTokens(run?.attrs.outputTokens ?? 0)}`,
              ],
              ["Cost", costLabel(run?.attrs.costMicroUsd ?? 0, []).amount],
              ["Models", models.length === 0 ? "none yet" : models.join(", ")],
            ].map(([label, value]) => (
              <div key={label} className="flex min-w-0 flex-col gap-0.5">
                <dt>
                  <Eyebrow>{label}</Eyebrow>
                </dt>
                <dd className="truncate text-text">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>

      <div className="mx-auto w-full max-w-[96rem] px-2 py-4 md:px-6">
        {trace.spans.length === 0 ? (
          <p className="px-2 py-8 text-sm text-text-muted">
            {stream.phase === "connecting" || stream.phase === "replaying"
              ? "Loading the event log…"
              : "No spans yet."}
          </p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
            <div className="grid grid-cols-[minmax(9rem,40%)_1fr_4rem] items-end border-b border-border px-3 py-2 font-mono text-2xs text-text-subtle tabular md:grid-cols-[22rem_1fr_5rem]">
              <span>Span</span>
              <span className="relative h-4">
                {ticks(duration).map((tick, index) => (
                  <span
                    key={tick}
                    className={cn(
                      "absolute",
                      index === 4 ? "-translate-x-full" : index === 0 ? "" : "-translate-x-1/2",
                    )}
                    style={{ left: `${(tick / duration) * 100}%` }}
                  >
                    {formatDuration(tick)}
                  </span>
                ))}
              </span>
              <span className="text-right">Latency</span>
            </div>
            <ol role="tree" aria-label="Trace spans">
              {trace.spans.map((span) => {
                const left = (span.startMs / duration) * 100;
                const width = ((span.endMs - span.startMs) / duration) * 100;
                const instant = span.startMs === span.endMs;
                const active = span.id === selectedId;
                return (
                  <li
                    key={span.id}
                    role="treeitem"
                    aria-level={span.depth + 1}
                    aria-selected={active}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedId(active ? null : span.id);
                      }}
                      className={cn(
                        "grid w-full grid-cols-[minmax(9rem,40%)_1fr_4rem] items-center border-b border-border/60 px-3 py-1.5 text-left last:border-b-0 hover:bg-surface-2/60 md:grid-cols-[22rem_1fr_5rem]",
                        active && "bg-accent-soft/60 hover:bg-accent-soft/60",
                      )}
                    >
                      <span
                        className="flex min-w-0 items-center gap-2 pr-3"
                        style={{ paddingLeft: `${span.depth * 0.875}rem` }}
                      >
                        <span
                          aria-hidden="true"
                          className={cn(
                            "size-1.5 shrink-0 rounded-full",
                            KIND_STYLE[span.kind].dot,
                          )}
                        />
                        <span className="truncate font-mono text-xs text-text">{span.name}</span>
                        {span.attrs.inputTokens !== undefined && span.kind === "model" ? (
                          <span className="hidden shrink-0 font-mono text-2xs text-text-subtle lg:inline">
                            {formatTokens(span.attrs.inputTokens)}→
                            {formatTokens(span.attrs.outputTokens ?? 0)}
                          </span>
                        ) : null}
                      </span>
                      <span className="relative h-5">
                        {[0.25, 0.5, 0.75].map((fraction) => (
                          <span
                            key={fraction}
                            aria-hidden="true"
                            className="absolute inset-y-0 w-px bg-border/60"
                            style={{ left: `${fraction * 100}%` }}
                          />
                        ))}
                        {instant ? (
                          <span
                            aria-hidden="true"
                            className={cn(
                              "absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rotate-45",
                              spanTone(span),
                            )}
                            style={{ left: `${left}%` }}
                          />
                        ) : (
                          <span
                            aria-hidden="true"
                            className={cn(
                              "absolute top-1/2 h-2.5 -translate-y-1/2 rounded-xs",
                              spanTone(span),
                              span.status === "running" && "motion-safe:animate-pulse",
                            )}
                            style={{ left: `${left}%`, width: `max(2px, ${width}%)` }}
                          />
                        )}
                      </span>
                      <span className="text-right font-mono text-2xs text-text-muted tabular">
                        {instant ? "·" : formatDuration(span.endMs - span.startMs)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
        )}
        <p className="mt-3 px-2 text-xs text-text-subtle">
          Built from the run&apos;s event log in the OpenTelemetry GenAI shape: run, steps,
          sub-agents, model calls, tool calls, policy decisions and critic flags. Diamonds are
          instant decisions.
        </p>
      </div>
      {selected === null ? null : (
        <SpanDrawer
          span={selected}
          onClose={() => {
            setSelectedId(null);
          }}
        />
      )}
    </div>
  );
}
