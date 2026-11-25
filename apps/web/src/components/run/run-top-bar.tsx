"use client";

import { Activity, RefreshCw, Square } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { missionLabel } from "@/lib/m2-contract";
import {
  type CitationMetric,
  costLabel,
  elapsedMs,
  formatDuration,
  formatTokens,
  type ModelMixEntry,
  type RunView,
} from "@/lib/runs/run-view";
import { cn } from "@/lib/utils";

import { actionButton, Chip, Eyebrow, type Tone } from "./primitives";

type ReadyView = Extract<RunView, { ok: true }>;

const STATUS: Record<ReadyView["state"]["status"], { label: string; tone: Tone }> = {
  planning: { label: "Planning", tone: "accent" },
  awaiting_plan_approval: { label: "Awaiting plan approval", tone: "warning" },
  running: { label: "Running", tone: "accent" },
  awaiting_approval: { label: "Needs approval", tone: "warning" },
  completed: { label: "Completed", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
};

const OUTCOME_LABEL: Partial<Record<string, { label: string; tone: Tone }>> = {
  cancelled: { label: "Stopped", tone: "neutral" },
  budget: { label: "Budget hit", tone: "warning" },
  policy: { label: "Policy denied", tone: "danger" },
  capacity: { label: "No capacity", tone: "warning" },
  site_unreachable: { label: "Site unreachable", tone: "warning" },
  invalid_input: { label: "Input rejected", tone: "neutral" },
  synthesis_invalid: { label: "Deliverable invalid", tone: "danger" },
  plan_rejected: { label: "Plan rejected", tone: "neutral" },
  unsupported: { label: "Unverified", tone: "warning" },
  worker_lost: { label: "Worker lost", tone: "danger" },
  runtime_unavailable: { label: "Not started", tone: "neutral" },
};

function Metric({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5", className)}>
      <dt>
        <Eyebrow>{label}</Eyebrow>
      </dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-1.5 font-mono text-sm text-text tabular">
        {children}
      </dd>
    </div>
  );
}

function CitationBadge({ metric }: { metric: CitationMetric | null }) {
  if (metric === null) return <span className="text-text-muted">n/a</span>;
  if (metric.kind === "reported") {
    const value = Math.round(metric.value * 100);
    return (
      <>
        <Chip tone={value >= 90 ? "success" : value >= 75 ? "neutral" : "warning"}>{value}%</Chip>
        {metric.checked === null ? null : (
          <span className="text-2xs text-text-subtle">{metric.checked} checked</span>
        )}
      </>
    );
  }
  const all = metric.resolved === metric.total;
  return (
    <span title="Citations that resolve to a fetched source; the critic's accuracy was not reported">
      <Chip tone={all ? "success" : "warning"}>
        {metric.resolved}/{metric.total} resolved
      </Chip>
    </span>
  );
}

function ModelChip({ entry }: { entry: ModelMixEntry }) {
  return (
    <Chip tone={entry.fellBackFrom && entry.calls === 0 ? "neutral" : "accent"}>
      <span className="truncate">
        {entry.provider} · {entry.model}
      </span>
      {entry.calls > 0 ? <span className="text-text-subtle">×{entry.calls}</span> : null}
      {entry.viaFallback ? (
        <span title="Served after a fallback" className="text-warning">
          ↺<span className="sr-only">, served after a fallback</span>
        </span>
      ) : null}
      {entry.fellBackFrom && entry.calls === 0 ? (
        <span className="sr-only">, skipped by a fallback</span>
      ) : null}
    </Chip>
  );
}

export function RunTopBar({
  view,
  now,
  onStop,
  stopping,
  stopError,
  runId,
  actions,
  replaying = false,
}: {
  runId: string;
  view: ReadyView;
  now: number;
  onStop: () => void;
  stopping: boolean;
  stopError: string | null;
  actions?: ReactNode;
  replaying?: boolean;
}) {
  const status =
    (view.outcome === null ? undefined : OUTCOME_LABEL[view.outcome.kind]) ??
    STATUS[view.state.status];
  const cost = costLabel(view.usage.costMicroUsd, view.providers);
  const elapsed = elapsedMs(view.createdAt, view.finishedAt, now);
  const active = view.outcome === null && !replaying;

  return (
    <div
      data-print="hide"
      className="border-b border-border bg-bg md:sticky md:top-14 md:z-30 md:bg-bg/90 md:backdrop-blur-md"
    >
      <div className="mx-auto flex max-w-[96rem] flex-col gap-4 px-4 py-4 md:px-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Eyebrow>{missionLabel(view.missionId)}</Eyebrow>
          <span aria-hidden="true" className="text-text-subtle">
            /
          </span>
          <h1 className="min-w-0 truncate font-mono text-base font-medium text-text">
            {view.target ?? "unknown target"}
          </h1>
          <Chip tone={status.tone}>
            {active ? (
              <span
                aria-hidden="true"
                className="size-1.5 rounded-full bg-current motion-safe:animate-pulse"
              />
            ) : null}
            {status.label}
          </Chip>
          {view.execution === "simulated" ? (
            <Chip tone="warning">Simulated · no research, no model calls</Chip>
          ) : null}
          {replaying ? <Chip tone="accent">Replay</Chip> : null}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {actions}
            <Link href={`/runs/${runId}/trace`} className={actionButton}>
              <Activity className="size-3.5" aria-hidden="true" />
              Trace
            </Link>
            {stopError === null ? null : (
              <span role="alert" className="text-xs text-danger">
                {stopError}
              </span>
            )}
            {active ? (
              <button
                type="button"
                onClick={onStop}
                disabled={stopping}
                className={cn(actionButton, "hover:border-danger hover:text-danger")}
              >
                {stopping ? (
                  <RefreshCw className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
                ) : (
                  <Square className="size-3 fill-current" aria-hidden="true" />
                )}
                {stopping ? "Stopping…" : "Stop"}
              </button>
            ) : null}
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:flex lg:flex-wrap lg:items-start lg:gap-x-8">
          <Metric label="Elapsed">
            <time dateTime={`PT${Math.floor(elapsed / 1000)}S`}>{formatDuration(elapsed)}</time>
          </Metric>
          <Metric label="Steps">
            {view.stepsDone}/{view.steps.length === 0 ? "–" : view.steps.length}
          </Metric>
          <Metric label="Tokens in / out / cached">
            {formatTokens(view.usage.inputTokens)} / {formatTokens(view.usage.outputTokens)} /{" "}
            {formatTokens(view.usage.cachedTokens)}
          </Metric>
          <Metric label="Cost">
            {cost.amount}
            {cost.note === null ? null : (
              <Chip tone={cost.note === "free tier" ? "success" : "neutral"}>{cost.note}</Chip>
            )}
          </Metric>
          <Metric label="Cache hit">
            {view.usage.cacheHitRate === null ? (
              <span className="text-text-muted" title="No provider reported cached tokens">
                n/a
              </span>
            ) : (
              `${Math.round(view.usage.cacheHitRate * 100)}%`
            )}
          </Metric>
          <Metric label="Lanes">
            {view.lanes.filter((lane) => lane.role !== null).length}
            {view.lanes.some((lane) => lane.status === "running" && lane.role !== null) ? (
              <span className="text-2xs text-accent">
                {
                  view.lanes.filter((lane) => lane.status === "running" && lane.role !== null)
                    .length
                }{" "}
                live
              </span>
            ) : null}
          </Metric>
          <Metric label="Citation accuracy">
            <CitationBadge metric={view.citation} />
          </Metric>
          <Metric label="Models" className="col-span-2 sm:col-span-3 lg:col-span-1">
            {view.modelMix.length === 0 ? (
              <span className="text-text-muted">none yet</span>
            ) : (
              view.modelMix.map((entry) => (
                <ModelChip key={`${entry.provider}:${entry.model}`} entry={entry} />
              ))
            )}
          </Metric>
        </dl>
      </div>
    </div>
  );
}
