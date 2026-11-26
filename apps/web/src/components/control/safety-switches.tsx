"use client";

import { OctagonX, Pause, Play } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { actionButton, Chip } from "@/components/run/primitives";
import { cn } from "@/lib/utils";

import { plural, utcDateTime } from "./format";
import { postJson, readError } from "./http";

export interface SwitchEvent {
  id: number;
  action: "workspace.runs_paused" | "workspace.runs_resumed" | "workspace.runs_stopped";
  at: string;
  runs: number | null;
}

const ACTIVITY_LABEL: Record<SwitchEvent["action"], string> = {
  "workspace.runs_paused": "New runs paused",
  "workspace.runs_resumed": "New runs resumed",
  "workspace.runs_stopped": "All active runs stopped",
};

const dangerButton = cn(actionButton, "border-danger/50 text-danger hover:border-danger");

function ErrorLine({ message }: { message: string | null }) {
  return message === null ? null : (
    <p role="alert" className="text-sm text-danger">
      {message}
    </p>
  );
}

function PauseSwitch({
  pausedAt,
  hasWorkspace,
}: {
  pausedAt: string | null;
  hasWorkspace: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paused = pausedAt !== null;

  const flip = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await postJson("/control/pause", { paused: !paused });
      if (response.ok) router.refresh();
      else setError(await readError(response));
    } catch {
      setError("Could not reach the server. Try again.");
    }
    setBusy(false);
  };

  return (
    <div data-switch="pause" className="flex min-w-0 flex-col gap-3 px-4 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-medium text-text">Pause new runs</h3>
        <Chip tone={paused ? "warning" : "success"}>{paused ? "Paused" : "Accepting runs"}</Chip>
      </div>
      <p className="max-w-2xl text-sm text-text-muted text-pretty">
        {paused ? (
          <>
            Paused since{" "}
            <time dateTime={pausedAt} className="text-text tabular">
              {utcDateTime.format(new Date(pausedAt))} UTC
            </time>
            . Every way of starting a run in this workspace is refused with a clear error: the web
            app, the API, MCP clients and the next step of an Autopilot run. Runs that were already
            going keep going.
          </>
        ) : (
          <>
            While paused, every way of starting a run in this workspace is refused with a clear
            error: the web app, the API, MCP clients and the next step of an Autopilot run. The
            database enforces it. Runs that are already going keep going.
          </>
        )}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy || !hasWorkspace}
          aria-pressed={paused}
          onClick={() => {
            void flip();
          }}
          className={actionButton}
        >
          {paused ? (
            <Play className="size-3.5" aria-hidden="true" />
          ) : (
            <Pause className="size-3.5" aria-hidden="true" />
          )}
          {busy ? "Saving…" : paused ? "Resume new runs" : "Pause new runs"}
        </button>
        {hasWorkspace ? null : (
          <span className="text-sm text-text-subtle">
            Available once this browser has a workspace: start a run first.
          </span>
        )}
      </div>
      <ErrorLine message={error} />
    </div>
  );
}

function StopAll({ activeRuns }: { activeRuns: number }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stopped, setStopped] = useState<number | null>(null);

  const stop = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await postJson("/control/stop-all", { confirm: "stop all runs" });
      if (response.ok) {
        const body = (await response.json().catch(() => null)) as { stopped?: unknown } | null;
        setStopped(typeof body?.stopped === "number" ? body.stopped : activeRuns);
        setConfirming(false);
        router.refresh();
      } else setError(await readError(response));
    } catch {
      setError("Could not reach the server. Try again.");
    }
    setBusy(false);
  };

  return (
    <div data-switch="stop-all" className="flex min-w-0 flex-col gap-3 px-4 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-medium text-text">Stop all active runs</h3>
        <Chip>{plural(activeRuns, "active run")}</Chip>
      </div>
      <p className="max-w-2xl text-sm text-text-muted text-pretty">
        Cancels every run that has not finished, the same way the Stop button on a run does. It
        cannot be undone: a stopped run keeps its log and the work it finished, and has to be
        started again by hand. It does not pause new runs.
      </p>
      {confirming ? (
        <div
          role="group"
          aria-label="Confirm stopping all active runs"
          className="flex flex-col gap-3 rounded-lg border border-danger/40 bg-danger-soft/40 px-3 py-3"
        >
          <p className="text-sm text-text">
            Stop {plural(activeRuns, "active run")} now? Approvals waiting on them are dropped.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void stop();
              }}
              className={dangerButton}
            >
              <OctagonX className="size-3.5" aria-hidden="true" />
              {busy ? "Stopping…" : `Yes, stop ${plural(activeRuns, "run")}`}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
              }}
              className={actionButton}
            >
              Keep them running
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={activeRuns === 0}
            onClick={() => {
              setStopped(null);
              setError(null);
              setConfirming(true);
            }}
            className={dangerButton}
          >
            <OctagonX className="size-3.5" aria-hidden="true" />
            Stop all active runs…
          </button>
          {activeRuns === 0 ? (
            <span className="text-sm text-text-subtle">
              Nothing is running, so nothing to stop.
            </span>
          ) : null}
        </div>
      )}
      {stopped === null ? null : (
        <p role="status" className="text-sm text-text-muted">
          Stopped {plural(stopped, "run")}. It is recorded in the workspace audit trail and listed
          below.
        </p>
      )}
      <ErrorLine message={error} />
    </div>
  );
}

export function SafetySwitches({
  pausedAt,
  activeRuns,
  hasWorkspace,
  activity,
}: {
  pausedAt: string | null;
  activeRuns: number;
  hasWorkspace: boolean;
  activity: SwitchEvent[];
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 rounded-xl border border-border bg-surface shadow-sm md:grid-cols-2">
        <PauseSwitch pausedAt={pausedAt} hasWorkspace={hasWorkspace} />
        <div className="min-w-0 border-t border-border md:border-t-0 md:border-l">
          <StopAll activeRuns={activeRuns} />
        </div>
      </div>
      {activity.length === 0 ? (
        <p className="text-sm text-text-subtle">
          Neither switch has been used in this workspace. Each use is written to the workspace audit
          trail before it takes effect and listed here.
        </p>
      ) : (
        <ol aria-label="Recent switch activity" className="flex flex-col gap-1">
          {activity.map((entry) => (
            <li
              key={entry.id}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 font-mono text-2xs text-text-subtle"
            >
              <time dateTime={entry.at} className="tabular">
                {utcDateTime.format(new Date(entry.at))} UTC
              </time>
              <span className="text-text-muted">
                {ACTIVITY_LABEL[entry.action]}
                {entry.runs === null ? "" : ` (${plural(entry.runs, "run")})`}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
