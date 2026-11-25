"use client";

import type { RunEvent } from "@delegate/runtime";
import { Plug } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { z } from "zod";

import { pendingToolCalls, type PendingToolCall } from "@/lib/runs/tool-approvals";

import { actionButton, Chip, Eyebrow, primaryButton } from "./primitives";

const errorSchema = z.object({ error: z.object({ message: z.string() }) });

function Card({ runId, call }: { runId: string; call: PendingToolCall }) {
  const headingId = useId();
  const [state, setState] = useState<"idle" | "approving" | "rejecting" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);
  const busy = state !== "idle";

  const send = async (decision: "approved" | "rejected") => {
    setState(decision === "approved" ? "approving" : "rejecting");
    setError(null);
    try {
      const response = await fetch(`/api/runs/${runId}/tool-approval`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approvalId: call.approvalId, decision }),
      });
      if (response.ok) {
        setState("sent");
        return;
      }
      const parsed = errorSchema.safeParse(await response.json().catch(() => null));
      setError(
        parsed.success ? parsed.data.error.message : `The server answered HTTP ${response.status}.`,
      );
    } catch {
      setError("Could not reach the server. Try again.");
    }
    setState("idle");
  };

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-xl border border-accent/40 bg-surface p-4 shadow-md motion-safe:animate-card-in"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
          <Plug className="size-4" aria-hidden="true" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Eyebrow>Approval needed · connector tool</Eyebrow>
          <h2 id={headingId} className="text-lg font-medium break-words text-text">
            Run <span className="font-mono">{call.action}</span>
            {call.server === null ? null : (
              <>
                {" "}
                on <span className="font-mono">{call.server}</span>?
              </>
            )}
          </h2>
          <p className="text-sm text-text-muted">{call.reason}</p>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone="warning">side effects</Chip>
          <Chip>arguments redacted for personal data</Chip>
        </div>
        <pre className="max-h-40 overflow-auto rounded-md bg-surface-2 p-3 font-mono text-xs break-all whitespace-pre-wrap text-text">
          {call.args === "" ? "(no arguments)" : call.args}
        </pre>
        <p className="text-xs text-text-subtle">
          The run is paused. Unanswered requests are rejected after 10 minutes. The decision is
          recorded in the run log and the audit view.
        </p>
      </div>
      {error === null ? null : (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={primaryButton}
          disabled={busy}
          onClick={() => {
            void send("approved");
          }}
        >
          {state === "approving" ? "Approving…" : state === "sent" ? "Sent" : "Approve this call"}
        </button>
        <button
          type="button"
          className={actionButton}
          disabled={busy}
          onClick={() => {
            void send("rejected");
          }}
        >
          {state === "rejecting" ? "Rejecting…" : "Reject"}
        </button>
      </div>
    </section>
  );
}

export function ToolApprovalCards({
  runId,
  events,
  running,
}: {
  runId: string;
  events: readonly RunEvent[];
  running: boolean;
}) {
  const pending = useMemo(() => pendingToolCalls(events), [events]);
  if (!running || pending.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      {pending.map((call) => (
        <Card key={call.approvalId} runId={runId} call={call} />
      ))}
    </div>
  );
}
