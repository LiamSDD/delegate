"use client";

import type { RunEvent } from "@delegate/runtime";
import { Pause, Play, RotateCcw, X } from "lucide-react";
import { type Dispatch, useId, useMemo } from "react";

import {
  REPLAY_SPEEDS,
  type ReplayAction,
  replayMarkers,
  type ReplayState,
} from "@/lib/runs/replay";
import { cn } from "@/lib/utils";

import { actionButton, Chip, Eyebrow } from "./primitives";

export function ReplayButton({ onStart }: { onStart: () => void }) {
  return (
    <button type="button" className={actionButton} onClick={onStart}>
      <Play className="size-3.5" aria-hidden="true" />
      Replay
    </button>
  );
}

function percentOf(cursor: number, total: number): number {
  return total <= 1 ? 100 : ((cursor - 1) / (total - 1)) * 100;
}

export function ReplayBar({
  events,
  state,
  dispatch,
}: {
  events: readonly RunEvent[];
  state: ReplayState;
  dispatch: Dispatch<ReplayAction>;
}) {
  const total = events.length;
  const markers = useMemo(() => replayMarkers(events), [events]);
  const scrubberId = useId();
  const current = events[state.cursor - 1];
  const finished = state.cursor >= total;
  return (
    <section
      aria-label="Replay controls"
      data-print="hide"
      className="flex flex-col gap-3 rounded-lg border border-accent/30 bg-accent-soft/40 px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Chip tone="accent">Replay</Chip>
        <p className="order-last basis-full text-sm text-text-muted sm:order-none sm:min-w-0 sm:flex-1 sm:basis-auto">
          Played back from the recorded event log. Nothing is re-run and no model is called.
        </p>
        <button
          type="button"
          className={cn(actionButton, "ml-auto sm:ml-0")}
          onClick={() => {
            dispatch({ type: "exit" });
          }}
        >
          <X className="size-3.5" aria-hidden="true" />
          Exit replay
        </button>
      </div>
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={cn(actionButton, "w-24")}
            onClick={() => {
              dispatch({ type: "toggle", total });
            }}
          >
            {state.playing ? (
              <Pause className="size-3.5" aria-hidden="true" />
            ) : finished ? (
              <RotateCcw className="size-3.5" aria-hidden="true" />
            ) : (
              <Play className="size-3.5" aria-hidden="true" />
            )}
            {state.playing ? "Pause" : finished ? "Restart" : "Play"}
          </button>
          <div
            role="radiogroup"
            aria-label="Replay speed"
            className="flex rounded-md border border-border bg-surface p-0.5"
          >
            {REPLAY_SPEEDS.map((speed) => (
              <button
                key={speed}
                type="button"
                role="radio"
                aria-checked={state.speed === speed}
                onClick={() => {
                  dispatch({ type: "speed", speed });
                }}
                className={cn(
                  "h-6 min-w-8 rounded-sm px-1.5 font-mono text-2xs tabular transition-colors",
                  state.speed === speed
                    ? "bg-accent text-accent-fg"
                    : "text-text-muted hover:text-text",
                )}
              >
                {speed}×
              </button>
            ))}
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label htmlFor={scrubberId} className="sr-only">
            Replay position
          </label>
          <div className="relative flex h-5 items-center">
            {markers.map((marker) => (
              <span
                key={`${marker.kind}-${marker.label}-${String(marker.cursor)}`}
                aria-hidden="true"
                title={marker.label}
                className={cn(
                  "pointer-events-none absolute top-0 h-5 w-px",
                  marker.kind === "end" ? "bg-text" : "bg-accent/60",
                )}
                style={{ left: `${percentOf(marker.cursor, total)}%` }}
              />
            ))}
            <input
              id={scrubberId}
              type="range"
              min={1}
              max={Math.max(1, total)}
              step={1}
              value={state.cursor}
              aria-valuetext={`Event ${String(state.cursor)} of ${String(total)}${current === undefined ? "" : `, ${current.type}`}`}
              onChange={(event) => {
                dispatch({ type: "seek", cursor: Number(event.target.value), total });
              }}
              className="roi-slider relative w-full"
              style={{ ["--fill" as string]: `${percentOf(state.cursor, total)}%` }}
            />
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {markers
              .filter((marker) => marker.kind === "step")
              .map((marker) => (
                <button
                  key={`${marker.label}-${String(marker.cursor)}`}
                  type="button"
                  onClick={() => {
                    dispatch({ type: "seek", cursor: marker.cursor, total });
                  }}
                  className={cn(
                    "font-mono text-2xs transition-colors hover:text-accent",
                    state.cursor >= marker.cursor ? "text-text" : "text-text-subtle",
                  )}
                >
                  {marker.label}
                </button>
              ))}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-start gap-0.5 md:items-end">
          <Eyebrow>
            Event {state.cursor} / {total}
          </Eyebrow>
          <span className="font-mono text-2xs text-text-subtle">
            {current === undefined
              ? ""
              : `${current.type} · ${new Date(current.at).toLocaleTimeString()}`}
          </span>
        </div>
      </div>
    </section>
  );
}
