"use client";

import { ArrowRight, Hammer, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { buildItRequest, type NextAction } from "@/lib/m3-contract";
import { startRun } from "@/lib/runs/start-run";
import { cn } from "@/lib/utils";

import { actionButton, primaryButton } from "./primitives";

export function BuildItButton({
  action,
  runId,
  primary,
  label = "Build it",
  className,
}: {
  action: NextAction;
  runId: string;
  primary: boolean;
  label?: string;
  className?: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = buildItRequest(action, runId);

  return (
    <span className={cn("flex flex-wrap items-center gap-2", className)}>
      <button
        type="button"
        disabled={request === null || pending}
        title={action.description}
        onClick={() => {
          if (request === null) return;
          setPending(true);
          setError(null);
          void startRun(request).then((result) => {
            if (result.ok) {
              router.push(`/runs/${result.runId}`);
              return;
            }
            setPending(false);
            setError(result.message);
          });
        }}
        className={cn(
          primary ? primaryButton : actionButton,
          primary && "shadow-[0_0_0_3px_var(--color-accent-soft)]",
        )}
      >
        {pending ? (
          <RefreshCw className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
        ) : (
          <Hammer className="size-3.5" aria-hidden="true" />
        )}
        {label}
        {primary ? <ArrowRight className="size-3.5" aria-hidden="true" /> : null}
      </button>
      {request === null ? (
        <span className="font-mono text-2xs text-text-subtle">Not buildable from this audit</span>
      ) : null}
      {error === null ? null : (
        <span role="alert" className="text-xs text-danger">
          {error}
        </span>
      )}
    </span>
  );
}
