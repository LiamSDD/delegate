"use client";

import { forkableSteps, MAX_FORK_OBJECTIVE_CHARS, type RunEvent } from "@delegate/runtime";
import { GitBranch, RefreshCw, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useMemo, useState } from "react";

import { forkRun } from "@/lib/runs/fork";
import { cn } from "@/lib/utils";

import { actionButton, Chip, Eyebrow, primaryButton } from "./primitives";

export function ForkButton({ onOpen, disabled }: { onOpen: () => void; disabled?: boolean }) {
  return (
    <button type="button" className={actionButton} onClick={onOpen} disabled={disabled}>
      <GitBranch className="size-3.5" aria-hidden="true" />
      Fork
    </button>
  );
}

export function ForkPanel({
  runId,
  events,
  onClose,
}: {
  runId: string;
  events: readonly RunEvent[];
  onClose: () => void;
}) {
  const router = useRouter();
  const steps = useMemo(() => {
    try {
      return forkableSteps(events);
    } catch {
      return [];
    }
  }, [events]);
  const [stepId, setStepId] = useState<string | null>(steps.at(-1)?.id ?? null);
  const chosen = steps.find((step) => step.id === stepId) ?? null;
  const [objectives, setObjectives] = useState<Record<string, string>>({});
  const objective = chosen === null ? "" : (objectives[chosen.id] ?? chosen.objective);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const objectiveId = useId();
  const groupId = useId();

  const submit = () => {
    if (chosen === null) return;
    setPending(true);
    setError(null);
    const trimmed = objective.trim();
    void forkRun(runId, {
      stepId: chosen.id,
      ...(trimmed === "" || trimmed === chosen.objective ? {} : { objective: trimmed }),
    }).then((result) => {
      if (result.ok) {
        router.push(`/runs/${result.runId}`);
        return;
      }
      setPending(false);
      setError(result.message);
    });
  };

  return (
    <section
      aria-labelledby={`${groupId}-title`}
      data-print="hide"
      className="flex flex-col gap-4 rounded-lg border border-border bg-surface px-4 py-4"
    >
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Eyebrow>Fork from step</Eyebrow>
          <h2 id={`${groupId}-title`} className="text-sm font-medium text-text">
            Re-run from a step in a new run
          </h2>
          <p className="max-w-2xl text-sm text-text-muted">
            Events before the chosen step are copied from this run’s log, so earlier steps are
            reused where the mission can restore them. The chosen step and everything after it run
            again. This run is not changed.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-surface-2 hover:text-text"
        >
          <X className="size-4" aria-hidden="true" />
          <span className="sr-only">Close fork panel</span>
        </button>
      </div>

      {steps.length === 0 ? (
        <p className="text-sm text-text-muted">
          No step in this run finished, so there is nothing to fork from.
        </p>
      ) : (
        <>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5">
              <Eyebrow>Step</Eyebrow>
            </legend>
            {steps.map((step, index) => (
              <label
                key={step.id}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2 transition-colors",
                  step.id === stepId
                    ? "border-accent/50 bg-accent-soft/40"
                    : "border-border hover:border-border-strong",
                )}
              >
                <input
                  type="radio"
                  name={`${groupId}-step`}
                  value={step.id}
                  checked={step.id === stepId}
                  onChange={() => {
                    setStepId(step.id);
                  }}
                  className="mt-1 accent-[var(--accent)]"
                />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-2xs text-text-subtle tabular">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className="font-mono text-sm text-text">{step.id}</span>
                    <Chip tone={step.outcome === "succeeded" ? "success" : "danger"}>
                      {step.outcome === "succeeded" ? "done" : "failed"}
                    </Chip>
                  </span>
                  <span className="text-sm text-text-muted">{step.objective}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <div className="flex flex-col gap-1.5">
            <label htmlFor={objectiveId}>
              <Eyebrow>Objective for {chosen?.id ?? "the step"} (optional edit)</Eyebrow>
            </label>
            <textarea
              id={objectiveId}
              value={objective}
              maxLength={MAX_FORK_OBJECTIVE_CHARS}
              rows={3}
              disabled={chosen === null}
              onChange={(event) => {
                if (chosen === null) return;
                setObjectives((current) => ({ ...current, [chosen.id]: event.target.value }));
              }}
              className="w-full resize-y rounded-md border border-border bg-bg px-3 py-2 text-sm text-text placeholder:text-text-subtle focus:border-accent focus:outline-none"
            />
            {chosen !== null && objective.trim() !== chosen.objective ? (
              <p className="text-xs text-text-subtle">
                Recorded in the fork’s log as a plan revision of {chosen.id}.
              </p>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className={primaryButton}
              disabled={pending || chosen === null}
              onClick={submit}
            >
              {pending ? (
                <RefreshCw className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
              ) : (
                <GitBranch className="size-3.5" aria-hidden="true" />
              )}
              {pending ? "Forking…" : `Fork from ${chosen?.id ?? "step"}`}
            </button>
            <button type="button" className={actionButton} onClick={onClose} disabled={pending}>
              Cancel
            </button>
            {error === null ? null : (
              <span role="alert" className="text-xs text-danger">
                {error}
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}
