"use client";

import { Square } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { actionButton } from "@/components/run/primitives";

import { readError } from "./http";

export function StopRunButton({ runId, name }: { runId: string; name: string }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "stopping" | "stopped">("idle");
  const [error, setError] = useState<string | null>(null);

  const stop = async () => {
    setState("stopping");
    setError(null);
    try {
      const response = await fetch(`/api/runs/${runId}/cancel`, { method: "POST" });
      if (response.ok || response.status === 409) {
        setState("stopped");
        router.refresh();
        return;
      }
      setError(await readError(response));
    } catch {
      setError("Could not reach the server. Try again.");
    }
    setState("idle");
  };

  return (
    <span className="flex min-w-0 flex-col items-start gap-1">
      <button
        type="button"
        disabled={state !== "idle"}
        aria-label={`Stop ${name}`}
        onClick={() => {
          void stop();
        }}
        className={actionButton}
      >
        <Square className="size-3" aria-hidden="true" />
        {state === "stopping" ? "Stopping…" : state === "stopped" ? "Stopped" : "Stop"}
      </button>
      {error === null ? null : (
        <span role="alert" className="text-xs text-danger">
          {error}
        </span>
      )}
    </span>
  );
}
