"use client";

import { ArrowRight, GitPullRequest, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { startShip, type StartShipRequest } from "@/lib/runs/start-ship";
import { cn } from "@/lib/utils";

import { actionButton, primaryButton } from "./primitives";

export interface ShipItButtonProps {
  ship: StartShipRequest;
  primary?: boolean;
  disabled?: boolean;
  disabledLabel?: string;
  className?: string;
}

export function ShipItButton({
  ship,
  primary = false,
  disabled = false,
  disabledLabel = "Arrives next",
  className,
}: ShipItButtonProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = `ship-error-${ship.improvement.id}`;

  return (
    <span className={cn("flex flex-wrap items-center gap-2", className)}>
      <button
        type="button"
        disabled={disabled || pending}
        aria-describedby={error === null ? undefined : errorId}
        title={
          disabled
            ? disabledLabel
            : "Implement this in a sandbox, run the repository's tests and ask you before shipping"
        }
        onClick={() => {
          setPending(true);
          setError(null);
          void startShip(ship).then((result) => {
            if (result.ok) {
              router.push(`/runs/${result.runId}`);
              return;
            }
            setPending(false);
            setError(
              result.retryAfterSeconds === null
                ? result.message
                : `${result.message} (retry in ${result.retryAfterSeconds} s)`,
            );
          });
        }}
        className={cn(primary ? primaryButton : actionButton)}
      >
        {pending ? (
          <RefreshCw className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
        ) : (
          <GitPullRequest className="size-3.5" aria-hidden="true" />
        )}
        {pending ? "Starting…" : "Ship it"}
        {primary && !pending ? <ArrowRight className="size-3.5" aria-hidden="true" /> : null}
      </button>
      {disabled ? (
        <span className="font-mono text-2xs text-text-subtle">{disabledLabel}</span>
      ) : null}
      {error === null ? null : (
        <span id={errorId} role="alert" className="text-xs text-danger">
          {error}
        </span>
      )}
    </span>
  );
}
