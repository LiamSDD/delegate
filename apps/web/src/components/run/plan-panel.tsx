"use client";

import type { PlanStep } from "@delegate/runtime";
import { Check, CornerDownRight, X } from "lucide-react";
import { useState } from "react";

import { type PlanDiffRow, planDiffRows, type PlanVersion, stepDepths } from "@/lib/runs/plan";
import { formatDuration, type PlanApprovalView, type StepView } from "@/lib/runs/run-view";
import { cn } from "@/lib/utils";

import { Chip, Eyebrow } from "./primitives";

function StepMarker({ status }: { status: StepView["status"] }) {
  if (status === "done") {
    return (
      <span className="flex size-4 items-center justify-center rounded-full bg-success-soft text-success">
        <Check className="size-2.5" strokeWidth={3} aria-hidden="true" />
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="flex size-4 items-center justify-center rounded-full bg-danger-soft text-danger">
        <X className="size-2.5" strokeWidth={3} aria-hidden="true" />
      </span>
    );
  }
  if (status === "running") {
    return (
      <span className="flex size-4 items-center justify-center">
        <span className="size-2 rounded-full bg-accent shadow-[0_0_0_3px_var(--accent-soft)] motion-safe:animate-pulse" />
      </span>
    );
  }
  return (
    <span className="flex size-4 items-center justify-center">
      <span className="size-2 rounded-full border border-border-strong" />
    </span>
  );
}

const STATUS_TEXT: Record<StepView["status"], string> = {
  pending: "Pending",
  running: "Running",
  done: "Done",
  failed: "Failed",
};

const CHANGE_STYLE: Record<PlanDiffRow["change"], string> = {
  added: "border-l-success bg-success-soft/50",
  removed: "border-l-danger bg-danger-soft/40",
  changed: "border-l-warning bg-warning-soft/50",
  same: "border-l-transparent",
};

const CHANGE_LABEL: Record<PlanDiffRow["change"], string> = {
  added: "added",
  removed: "removed",
  changed: "changed",
  same: "",
};

function PlanRow({
  step,
  view,
  depth,
  now,
  diff,
}: {
  step: PlanStep;
  view: StepView | null;
  depth: number;
  now: number;
  diff: PlanDiffRow | null;
}) {
  const status = view?.status ?? "pending";
  const duration =
    view?.durationMs ??
    (status === "running" && view?.startedAt !== null && view?.startedAt !== undefined
      ? now - Date.parse(view.startedAt)
      : null);
  const removed = diff?.change === "removed";
  return (
    <li
      className={cn(
        "relative flex gap-2.5 rounded-md border-l-2 py-2 pr-2",
        diff === null ? "border-l-transparent" : CHANGE_STYLE[diff.change],
      )}
      style={{ paddingLeft: `${0.5 + Math.min(depth, 4) * 0.875}rem` }}
    >
      {depth > 0 ? (
        <CornerDownRight
          aria-hidden="true"
          className="mt-0.5 size-3.5 shrink-0 text-text-subtle"
          strokeWidth={1.5}
        />
      ) : null}
      <span className="pt-0.5">
        <StepMarker status={removed ? "pending" : status} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p
          className={cn(
            "text-sm leading-5 break-words",
            removed && "text-text-subtle line-through",
            !removed && status === "pending" ? "text-text-muted" : "text-text",
          )}
        >
          {step.objective}
        </p>
        <p className="flex flex-wrap items-center gap-1.5 font-mono text-2xs text-text-subtle tabular">
          <span className="sr-only">Status:</span>
          <span
            className={cn(
              status === "running" && "text-accent",
              status === "failed" && "text-danger",
              status === "done" && "text-success",
            )}
          >
            {STATUS_TEXT[status]}
          </span>
          <Chip>{step.role}</Chip>
          {duration === null ? null : <span>{formatDuration(duration)}</span>}
          <span title="Budget share">{Math.round(step.budgetShare * 100)}%</span>
          {diff !== null && diff.change !== "same" ? (
            <span
              className={cn(
                diff.change === "added" && "text-success",
                diff.change === "removed" && "text-danger",
                diff.change === "changed" && "text-warning",
              )}
            >
              {CHANGE_LABEL[diff.change]}
              {diff.fields.length > 0 ? ` · ${diff.fields.join(", ")}` : ""}
            </span>
          ) : null}
        </p>
        {step.inputs.length === 0 ? null : (
          <p className="truncate font-mono text-2xs text-text-subtle">
            after {step.inputs.join(", ")}
          </p>
        )}
        {view?.summary === null || view?.summary === undefined ? null : (
          <p className="text-xs break-words text-text-muted">{view.summary}</p>
        )}
      </div>
    </li>
  );
}

export function PlanPanel({
  versions,
  steps,
  now,
  waiting,
  approval,
}: {
  versions: readonly PlanVersion[];
  steps: readonly StepView[];
  now: number;
  waiting: boolean;
  approval: PlanApprovalView | null;
}) {
  const latest = versions.at(-1) ?? null;
  const [chosen, setChosen] = useState<number | null>(null);
  const selected = versions.find((version) => version.version === chosen) ?? latest;
  const index = selected === null ? -1 : versions.indexOf(selected);
  const previous = index > 0 ? versions[index - 1] : undefined;
  const byId = new Map(steps.map((step) => [step.id, step]));
  const rows: { step: PlanStep; diff: PlanDiffRow | null }[] =
    selected === null
      ? []
      : previous === undefined
        ? selected.steps.map((step) => ({ step, diff: null }))
        : planDiffRows(previous.steps, selected.steps).map((row) => ({
            step: row.step,
            diff: row,
          }));
  const depths = stepDepths(selected?.steps ?? []);

  return (
    <section aria-labelledby="plan-heading" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 id="plan-heading">
          <Eyebrow>Plan</Eyebrow>
        </h2>
        {versions.length > 1 ? (
          <div
            role="group"
            aria-label="Plan version"
            className="flex rounded-md border border-border bg-surface-2 p-0.5"
          >
            {versions.map((version) => (
              <button
                key={version.seq}
                type="button"
                aria-pressed={version === selected}
                onClick={() => {
                  setChosen(version.version);
                }}
                className={cn(
                  "h-6 rounded-sm px-1.5 font-mono text-2xs tabular transition-colors",
                  version === selected
                    ? "bg-surface text-text shadow-sm"
                    : "text-text-muted hover:text-text",
                )}
              >
                v{version.version}
              </button>
            ))}
          </div>
        ) : latest === null ? null : (
          <span className="font-mono text-2xs text-text-subtle">v{latest.version}</span>
        )}
      </div>
      {selected === null ? (
        <div className="rounded-lg border border-dashed border-border px-3 py-4 text-sm text-text-muted">
          {waiting ? "Waiting for the planner to propose steps…" : "This run has no plan."}
        </div>
      ) : (
        <>
          {selected.reason === null ? null : (
            <p className="rounded-md border border-border bg-surface-2/60 px-2.5 py-2 text-xs text-text-muted">
              <span className="font-medium text-text">v{selected.version} · </span>
              {selected.reason}
            </p>
          )}
          {selected !== latest ? (
            <p className="font-mono text-2xs text-text-subtle">
              Viewing an earlier version. Live status shows on v{latest?.version}.
            </p>
          ) : null}
          <ol className="flex flex-col gap-0.5">
            {rows.map(({ step, diff }) => (
              <PlanRow
                key={`${diff?.change ?? "row"}-${step.id}`}
                step={step}
                view={selected === latest ? (byId.get(step.id) ?? null) : null}
                depth={depths.get(step.id) ?? 0}
                now={now}
                diff={diff}
              />
            ))}
          </ol>
          {approval === null ? null : (
            <p className="font-mono text-2xs text-text-subtle">
              v{approval.version} {approval.auto ? "auto-approved" : "approved"} ·{" "}
              {new Date(approval.at).toLocaleTimeString()}
            </p>
          )}
        </>
      )}
    </section>
  );
}
