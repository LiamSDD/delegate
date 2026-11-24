"use client";

import type { PlanStep } from "@delegate/runtime";
import { ArrowDown, ArrowUp, Check, Hand, RefreshCw, X } from "lucide-react";
import { useId, useState } from "react";
import { z } from "zod";

import {
  budgetTotal,
  type DraftStep,
  draftFromPlan,
  draftIssues,
  draftToSteps,
  moveStep,
} from "@/lib/runs/plan";
import { cn } from "@/lib/utils";

import { actionButton, Chip, Eyebrow, primaryButton } from "./primitives";

const errorSchema = z.object({
  error: z.object({ message: z.string(), issues: z.array(z.string()).optional() }),
});

type Submission = "idle" | "approving" | "rejecting" | "sent";

export function PlanApprovalCard({
  runId,
  version,
  steps,
}: {
  runId: string;
  version: number;
  steps: readonly PlanStep[];
}) {
  const [draft, setDraft] = useState<DraftStep[]>(() => draftFromPlan(steps));
  const [submission, setSubmission] = useState<Submission>("idle");
  const [error, setError] = useState<string[] | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const headingId = useId();
  const issues = draftIssues(steps, draft);
  const total = budgetTotal(draft);
  const edited = JSON.stringify(draftToSteps(draft)) !== JSON.stringify(steps);
  const busy = submission !== "idle";

  const update = (id: string, change: (entry: DraftStep) => DraftStep) => {
    setDraft((current) => current.map((entry) => (entry.step.id === id ? change(entry) : entry)));
  };

  const send = async (body: unknown, mode: "approving" | "rejecting") => {
    setSubmission(mode);
    setError(null);
    try {
      const response = await fetch(`/api/runs/${runId}/plan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (response.ok) {
        setSubmission("sent");
        return;
      }
      const parsed = errorSchema.safeParse(await response.json().catch(() => null));
      setError(
        parsed.success
          ? [parsed.data.error.message, ...(parsed.data.error.issues ?? [])]
          : [`The server answered HTTP ${response.status}.`],
      );
    } catch {
      setError(["Could not reach the server. Try again."]);
    }
    setSubmission("idle");
  };

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-4 rounded-xl border border-accent/40 bg-surface p-4 shadow-md motion-safe:animate-card-in md:p-5"
    >
      <div className="flex flex-wrap items-start gap-3">
        <span className="mt-0.5 flex size-8 items-center justify-center rounded-md bg-accent-soft text-accent">
          <Hand className="size-4" aria-hidden="true" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Eyebrow>Approval needed · plan v{version}</Eyebrow>
          <h2 id={headingId} className="text-lg font-medium text-text">
            Review the plan before any agent starts
          </h2>
          <p className="text-sm text-text-muted">
            Edit objectives, turn steps off, reorder within their dependencies or rebalance the
            budget. Capabilities and roles are fixed by the planner and enforced by the runtime.
          </p>
        </div>
        <Chip tone={edited ? "warning" : "neutral"}>{edited ? "edited" : "as proposed"}</Chip>
      </div>

      <ol className="flex flex-col gap-2">
        {draft.map((entry, index) => {
          const { step, enabled } = entry;
          const up = moveStep(draft, step.id, -1);
          const down = moveStep(draft, step.id, 1);
          return (
            <li
              key={step.id}
              className={cn(
                "flex flex-col gap-2 rounded-lg border px-3 py-2.5 transition-colors sm:flex-row sm:items-start",
                enabled
                  ? "border-border bg-surface"
                  : "border-dashed border-border bg-surface-2/50",
              )}
            >
              <div className="flex items-center gap-2 sm:pt-1">
                <span className="w-5 font-mono text-2xs text-text-subtle tabular">{index + 1}</span>
                <label className="relative inline-flex cursor-pointer items-center">
                  <input
                    type="checkbox"
                    checked={enabled}
                    disabled={busy}
                    onChange={(event) => {
                      update(step.id, (current) => ({ ...current, enabled: event.target.checked }));
                    }}
                    className="peer sr-only"
                  />
                  <span className="h-4 w-7 rounded-full bg-border-strong transition-colors peer-checked:bg-accent peer-focus-visible:ring-2 peer-focus-visible:ring-focus" />
                  <span className="absolute left-0.5 size-3 rounded-full bg-surface shadow-sm transition-transform peer-checked:translate-x-3" />
                  <span className="sr-only">Run step {step.id}</span>
                </label>
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <label className="sr-only" htmlFor={`objective-${step.id}`}>
                  Objective for {step.id}
                </label>
                <textarea
                  id={`objective-${step.id}`}
                  value={step.objective}
                  disabled={!enabled || busy}
                  rows={2}
                  maxLength={500}
                  onChange={(event) => {
                    update(step.id, (current) => ({
                      ...current,
                      step: { ...current.step, objective: event.target.value },
                    }));
                  }}
                  className={cn(
                    "w-full resize-none rounded-md border border-transparent bg-transparent px-1.5 py-1 text-sm leading-5 text-text hover:border-border focus:border-accent focus:outline-none",
                    !enabled && "text-text-subtle line-through",
                  )}
                />
                <div className="flex flex-wrap items-center gap-1.5 px-1.5 font-mono text-2xs text-text-subtle">
                  <Chip>{step.role}</Chip>
                  {step.capabilities.map((capability) => (
                    <Chip key={capability} tone="accent">
                      {capability}
                    </Chip>
                  ))}
                  {step.inputs.length === 0 ? null : <span>after {step.inputs.join(", ")}</span>}
                </div>
              </div>
              <div className="flex items-center gap-1.5 sm:pt-1">
                <label className="flex items-center gap-1 font-mono text-2xs text-text-subtle">
                  <span className="sr-only">Budget share for {step.id}, percent</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={Math.round(step.budgetShare * 100)}
                    disabled={!enabled || busy}
                    onChange={(event) => {
                      const value = Math.min(100, Math.max(0, Number(event.target.value) || 0));
                      update(step.id, (current) => ({
                        ...current,
                        step: { ...current.step, budgetShare: value / 100 },
                      }));
                    }}
                    className="h-7 w-14 rounded-md border border-border bg-surface px-1.5 text-right text-xs text-text tabular focus:border-accent focus:outline-none"
                  />
                  %
                </label>
                <button
                  type="button"
                  aria-label={`Move ${step.id} up`}
                  disabled={up === null || busy}
                  title={up === null ? "Blocked by a dependency" : "Move up"}
                  onClick={() => {
                    if (up !== null) setDraft(up);
                  }}
                  className="flex size-7 items-center justify-center rounded-md text-text-muted hover:bg-surface-2 hover:text-text disabled:opacity-30"
                >
                  <ArrowUp className="size-3.5" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label={`Move ${step.id} down`}
                  disabled={down === null || busy}
                  title={down === null ? "Blocked by a dependency" : "Move down"}
                  onClick={() => {
                    if (down !== null) setDraft(down);
                  }}
                  className="flex size-7 items-center justify-center rounded-md text-text-muted hover:bg-surface-2 hover:text-text disabled:opacity-30"
                >
                  <ArrowDown className="size-3.5" aria-hidden="true" />
                </button>
              </div>
            </li>
          );
        })}
      </ol>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-2xs tabular">
        <span className={cn(total > 1 + 1e-9 ? "text-danger" : "text-text-muted")}>
          Budget allocated {Math.round(total * 100)}% of 100%
        </span>
        <span className="text-text-subtle">
          {draftToSteps(draft).length}/{draft.length} steps on
        </span>
      </div>

      {issues.length > 0 || error !== null ? (
        <ul
          role="alert"
          className="flex flex-col gap-1 rounded-md border border-danger/40 bg-danger-soft/40 px-3 py-2 text-xs text-danger"
        >
          {[...(error ?? []), ...issues].map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      ) : null}

      {rejecting ? (
        <div className="flex flex-col gap-2">
          <label htmlFor={`${headingId}-reason`} className="text-xs text-text-muted">
            Reason (optional, recorded in the audit log)
          </label>
          <input
            id={`${headingId}-reason`}
            value={reason}
            maxLength={500}
            onChange={(event) => {
              setReason(event.target.value);
            }}
            className="h-8 rounded-md border border-border bg-surface px-2 text-sm text-text focus:border-accent focus:outline-none"
          />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {submission === "sent" ? (
          <p role="status" className="flex items-center gap-2 text-sm text-text-muted">
            <RefreshCw className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
            Decision recorded. Waiting for the runtime to pick it up…
          </p>
        ) : rejecting ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                const trimmed = reason.trim();
                void send(
                  trimmed === ""
                    ? { decision: "rejected" }
                    : { decision: "rejected", reason: trimmed },
                  "rejecting",
                );
              }}
              className={cn(actionButton, "border-danger/50 text-danger hover:border-danger")}
            >
              <X className="size-3.5" aria-hidden="true" />
              {submission === "rejecting" ? "Rejecting…" : "Reject plan"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setRejecting(false);
              }}
              className={actionButton}
            >
              Back
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              disabled={busy || issues.length > 0}
              onClick={() => {
                void send(
                  edited
                    ? { decision: "approved", steps: draftToSteps(draft) }
                    : { decision: "approved" },
                  "approving",
                );
              }}
              className={primaryButton}
            >
              <Check className="size-3.5" aria-hidden="true" />
              {submission === "approving"
                ? "Approving…"
                : edited
                  ? "Approve edited plan"
                  : "Approve plan"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setRejecting(true);
              }}
              className={actionButton}
            >
              Reject
            </button>
            {edited ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setDraft(draftFromPlan(steps));
                }}
                className="h-8 px-2 text-sm text-text-muted hover:text-text"
              >
                Reset edits
              </button>
            ) : null}
          </>
        )}
        <span className="ml-auto font-mono text-2xs text-text-subtle">
          Times out and rejects after 10 minutes
        </span>
      </div>
    </section>
  );
}
