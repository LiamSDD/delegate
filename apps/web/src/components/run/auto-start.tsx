"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { type StartRunRequest, startRun } from "@/lib/runs/start-run";

import { primaryButton } from "./primitives";

type Phase = { kind: "starting" } | { kind: "failed"; message: string };

export function AutoStartRun({ request }: { request: StartRunRequest }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });
  const started = useRef(false);

  const start = useCallback(() => {
    setPhase({ kind: "starting" });
    void startRun(request).then((result) => {
      if (result.ok) {
        router.replace(`/runs/${result.runId}`);
        return;
      }
      setPhase({ kind: "failed", message: result.message });
    });
  }, [request, router]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    start();
  }, [start]);

  if (phase.kind === "starting") {
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-text-muted">
        <RefreshCw className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
        Starting the run…
      </p>
    );
  }
  return (
    <div className="flex flex-col items-start gap-3">
      <p role="alert" className="text-sm text-danger">
        {phase.message}
      </p>
      <button type="button" onClick={start} className={primaryButton}>
        Try again
      </button>
    </div>
  );
}
