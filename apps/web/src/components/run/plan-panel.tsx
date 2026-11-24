"use client";

import { Check, X } from "lucide-react";

import { formatDuration, type StepView } from "@/lib/runs/run-view";
import { cn } from "@/lib/utils";

import { Eyebrow } from "./primitives";

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

export function PlanPanel({
  steps,
  now,
  waiting,
  planVersion,
}: {
  steps: readonly StepView[];
  now: number;
  waiting: boolean;
  planVersion: number | null;
}) {
  return (
    <section aria-labelledby="plan-heading" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="plan-heading">
          <Eyebrow>Plan</Eyebrow>
        </h2>
        {planVersion === null ? null : (
          <span className="font-mono text-2xs text-text-subtle">v{planVersion}</span>
        )}
      </div>
      {steps.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-3 py-4 text-sm text-text-muted">
          {waiting ? "Waiting for the planner to propose steps…" : "This run has no plan."}
        </div>
      ) : (
        <ol className="flex flex-col">
          {steps.map((step, index) => {
            const duration =
              step.durationMs ??
              (step.status === "running" && step.startedAt !== null
                ? now - Date.parse(step.startedAt)
                : null);
            return (
              <li key={step.id} className="relative flex gap-3 pb-4 last:pb-0">
                {index < steps.length - 1 ? (
                  <span
                    aria-hidden="true"
                    className={cn(
                      "absolute top-5 bottom-0 left-2 w-px -translate-x-1/2",
                      step.status === "done" ? "bg-success/40" : "bg-border",
                    )}
                  />
                ) : null}
                <span className="relative pt-0.5">
                  <StepMarker status={step.status} />
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <p
                    className={cn(
                      "text-sm",
                      step.status === "pending" ? "text-text-muted" : "text-text",
                    )}
                  >
                    {step.objective}
                  </p>
                  <p className="flex flex-wrap items-center gap-x-2 font-mono text-2xs text-text-subtle tabular">
                    <span className="sr-only">Status:</span>
                    <span
                      className={cn(
                        step.status === "running" && "text-accent",
                        step.status === "failed" && "text-danger",
                        step.status === "done" && "text-success",
                      )}
                    >
                      {STATUS_TEXT[step.status]}
                    </span>
                    {step.role === null ? null : <span>{step.role}</span>}
                    {duration === null ? null : <span>{formatDuration(duration)}</span>}
                  </p>
                  {step.summary === null ? null : (
                    <p className="text-xs text-text-muted">{step.summary}</p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
