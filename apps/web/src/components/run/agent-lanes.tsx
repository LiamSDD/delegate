"use client";

import { ChevronRight, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { type Lane, RUN_LANE } from "@/lib/runs/lanes";
import { elapsedMs, formatDuration } from "@/lib/runs/run-view";
import { cn } from "@/lib/utils";

import { ActivityItemCard } from "./activity-lane";
import { Chip, Eyebrow } from "./primitives";

function LaneCard({
  lane,
  open,
  onToggle,
  liveFromSeq,
  now,
}: {
  lane: Lane;
  open: boolean;
  onToggle: () => void;
  liveFromSeq: number | null;
  now: number;
}) {
  const running = lane.status === "running";
  const bodyId = `lane-${lane.id}`;
  const fresh = liveFromSeq !== null && (lane.items[0]?.seq ?? 0) > liveFromSeq;
  return (
    <li
      className={cn(
        "overflow-hidden rounded-lg border bg-surface shadow-sm",
        running ? "border-accent/40" : "border-border",
        fresh && "motion-safe:animate-card-in",
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={onToggle}
        className="flex w-full flex-wrap items-center gap-2 px-3 py-2.5 text-left hover:bg-surface-2/60"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-text-subtle transition-transform",
            open && "rotate-90",
          )}
        />
        {running ? (
          <span
            aria-hidden="true"
            className="size-2 shrink-0 rounded-full bg-accent shadow-[0_0_0_3px_var(--accent-soft)] motion-safe:animate-pulse"
          />
        ) : (
          <span
            aria-hidden="true"
            className={cn(
              "size-2 shrink-0 rounded-full",
              lane.status === "done" ? "bg-success" : "bg-danger",
            )}
          />
        )}
        <span className="text-sm font-medium text-text">
          {lane.id === RUN_LANE ? "Orchestrator" : (lane.role ?? "agent")}
        </span>
        <span className="min-w-0 truncate font-mono text-2xs text-text-subtle">
          {lane.id === RUN_LANE ? "run" : lane.id}
        </span>
        <span className="ml-auto flex flex-wrap items-center gap-1.5">
          {lane.flags > 0 ? (
            <Chip tone="warning">
              <TriangleAlert className="size-3" aria-hidden="true" />
              {lane.flags}
            </Chip>
          ) : null}
          {lane.model === null ? (
            lane.modelRole === null ? null : (
              <Chip>{lane.modelRole}</Chip>
            )
          ) : (
            <Chip tone="accent" className="max-w-48">
              <span className="truncate">{lane.model}</span>
            </Chip>
          )}
          <span className="font-mono text-2xs text-text-subtle tabular">
            {lane.items.length} · {formatDuration(elapsedMs(lane.startedAt, lane.endedAt, now))}
          </span>
        </span>
      </button>
      {open ? (
        <div id={bodyId} className="border-t border-border bg-bg/40 px-2 py-2">
          {lane.items.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-text-muted">
              {running ? "Spawned. Waiting for its first tool call…" : "No activity recorded."}
            </p>
          ) : (
            <ol role="log" aria-live="off" className="flex flex-col gap-1.5">
              {lane.items.map((item) => (
                <ActivityItemCard
                  key={item.key}
                  item={item}
                  fresh={liveFromSeq !== null && item.seq > liveFromSeq}
                />
              ))}
            </ol>
          )}
        </div>
      ) : null}
    </li>
  );
}

export function AgentLanes({
  lanes,
  liveFromSeq,
  waiting,
  now,
}: {
  lanes: readonly Lane[];
  liveFromSeq: number | null;
  waiting: boolean;
  now: number;
}) {
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const running = lanes.filter((lane) => lane.status === "running").length;
  const allClosed = lanes.every((lane) => !(overrides[lane.id] ?? lane.status === "running"));
  return (
    <section aria-labelledby="lanes-heading" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 id="lanes-heading" className="flex items-baseline gap-2">
          <Eyebrow>Sub-agents</Eyebrow>
          <span className="font-mono text-2xs text-text-subtle tabular">
            {lanes.length} lane{lanes.length === 1 ? "" : "s"}
            {running > 0 ? ` · ${running} running` : ""}
          </span>
        </h2>
        {lanes.length > 0 ? (
          <button
            type="button"
            onClick={() => {
              setOverrides(Object.fromEntries(lanes.map((lane) => [lane.id, allClosed])));
            }}
            className="font-mono text-2xs text-text-muted hover:text-text"
          >
            {allClosed ? "Expand all" : "Collapse all"}
          </button>
        ) : null}
      </div>
      {lanes.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-3 py-4 text-sm text-text-muted">
          {waiting
            ? "Each sub-agent gets its own lane here once the plan is approved."
            : "This run recorded no agent activity."}
        </div>
      ) : (
        <ol className="flex flex-col gap-2">
          {lanes.map((lane) => (
            <LaneCard
              key={lane.id}
              lane={lane}
              open={overrides[lane.id] ?? lane.status === "running"}
              onToggle={() => {
                setOverrides((current) => ({
                  ...current,
                  [lane.id]: !(current[lane.id] ?? lane.status === "running"),
                }));
              }}
              liveFromSeq={liveFromSeq}
              now={now}
            />
          ))}
        </ol>
      )}
    </section>
  );
}
