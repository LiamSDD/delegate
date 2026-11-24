"use client";

import { RefreshCw, Square } from "lucide-react";
import type { ReactNode } from "react";

import {
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
  awaiting_plan_approval: { label: "Plan ready", tone: "accent" },
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
  synthesis_invalid: { label: "Brief invalid", tone: "danger" },
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
}: {
  view: ReadyView;
  now: number;
  onStop: () => void;
  stopping: boolean;
  stopError: string | null;
}) {
  const status =
    (view.outcome === null ? undefined : OUTCOME_LABEL[view.outcome.kind]) ??
    STATUS[view.state.status];
  const cost = costLabel(view.usage.costMicroUsd, view.providers);
  const elapsed = elapsedMs(view.createdAt, view.finishedAt, now);
  const active = view.outcome === null;

  return (
    <div className="border-b border-border bg-bg md:sticky md:top-14 md:z-30 md:bg-bg/90 md:backdrop-blur-md">
      <div className="mx-auto flex max-w-[96rem] flex-col gap-4 px-4 py-4 md:px-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Eyebrow>Company X-ray</Eyebrow>
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
          <div className="ml-auto flex items-center gap-2">
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
