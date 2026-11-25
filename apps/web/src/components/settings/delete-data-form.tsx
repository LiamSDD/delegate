"use client";

import { Trash2 } from "lucide-react";
import Link from "next/link";
import { type SyntheticEvent, useId, useState } from "react";
import { z } from "zod";

import { postJson, readError } from "@/components/control/http";
import { actionButton } from "@/components/run/primitives";
import { cn } from "@/lib/utils";

const receiptSchema = z.object({
  deleted: z.literal(true),
  counts: z.record(z.string(), z.number().int().nonnegative()),
});

const COUNT_LABEL: Record<string, string> = {
  runs: "runs",
  events: "run events",
  artifacts: "artifacts",
  approvals: "approval requests",
  assistants: "assistants",
  documents: "documents",
  memories: "memories",
  playbooks: "workspace playbooks",
  policies: "workspace policies",
  connectors: "MCP connectors",
  githubInstallations: "GitHub installations",
  apiTokens: "API tokens",
  settings: "settings records",
  auditEntries: "earlier audit entries",
};

export function normaliseConfirmation(typed: string): string {
  return typed.trim().replace(/\s+/g, " ").toLowerCase();
}

export function DeleteDataForm({ phrase, disabled }: { phrase: string; disabled: boolean }) {
  const inputId = useId();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Record<string, number> | null>(null);
  const confirmed = normaliseConfirmation(typed) === phrase;

  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      const response = await postJson("/settings/data/delete", { confirm: typed });
      if (response.ok) {
        const parsed = receiptSchema.safeParse(await response.json().catch(() => null));
        setReceipt(parsed.success ? parsed.data.counts : {});
      } else setError(await readError(response));
    } catch {
      setError(
        "Could not reach the server. Nothing is known to have been deleted; reload to check.",
      );
    }
    setBusy(false);
  };

  if (receipt !== null) {
    const removed = Object.entries(receipt).filter(([, count]) => count > 0);
    return (
      <div
        role="status"
        className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface px-4 py-4"
      >
        <p className="text-base font-medium text-text">
          Your data is deleted and this browser is signed out of the workspace.
        </p>
        {removed.length === 0 ? (
          <p className="text-sm text-text-muted">The workspace held nothing to remove.</p>
        ) : (
          <ul className="grid grid-cols-1 gap-x-8 gap-y-1 text-sm text-text-muted sm:grid-cols-2">
            {removed.map(([name, count]) => (
              <li key={name}>
                <span className="font-mono text-text tabular">{count}</span>{" "}
                {COUNT_LABEL[name] ?? name}
              </li>
            ))}
          </ul>
        )}
        <p className="text-sm text-text-muted">
          One audit entry recording this deletion, with these counts and no content, is kept until
          the retention period ends.
        </p>
        <Link href="/" prefetch={false} className={cn(actionButton, "self-start")}>
          Back to the home page
        </Link>
      </div>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        void submit(event);
      }}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-danger/40 bg-surface px-4 py-4"
    >
      <label htmlFor={inputId} className="text-sm text-text">
        Type <span className="font-mono font-medium">{phrase}</span> to confirm
      </label>
      <input
        id={inputId}
        value={typed}
        maxLength={100}
        disabled={disabled || busy}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        onChange={(event) => {
          setTyped(event.target.value);
        }}
        className="h-9 w-full max-w-sm min-w-0 rounded-md border border-border bg-surface px-3 font-mono text-sm text-text focus-visible:border-danger focus-visible:outline-none"
      />
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={disabled || busy || !confirmed}
          className={cn(actionButton, "border-danger/50 text-danger hover:border-danger")}
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
          {busy ? "Deleting…" : "Delete my data permanently"}
        </button>
        {disabled ? (
          <span className="text-sm text-text-subtle">
            There is no workspace in this browser, so there is nothing to delete.
          </span>
        ) : null}
      </div>
      {error === null ? null : (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </form>
  );
}
