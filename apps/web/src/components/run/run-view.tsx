"use client";

import Link from "next/link";
import { type KeyboardEvent, useMemo, useRef, useState } from "react";

import { parseBrief } from "@/lib/runs/brief";
import { buildRunView, elapsedMs } from "@/lib/runs/run-view";
import { cn } from "@/lib/utils";

import { ActivityLane } from "./activity-lane";
import { BriefPanel } from "./brief-panel";
import { PlanPanel } from "./plan-panel";
import { Eyebrow, useNow } from "./primitives";
import { OutcomeBanner, StreamBanner } from "./run-status";
import { RunTopBar } from "./run-top-bar";
import { useRunStream } from "./use-run-stream";

const TABS = [
  { id: "plan", label: "Plan" },
  { id: "activity", label: "Activity" },
  { id: "brief", label: "Brief" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export interface RunViewProps {
  runId: string;
  target: string | null;
  simulated: boolean;
}

function UnknownRun() {
  return (
    <div className="mx-auto flex max-w-content flex-col gap-4 px-6 pt-16 pb-24">
      <Eyebrow>Run · 404</Eyebrow>
      <h1 className="font-serif text-display-sm tracking-display">This run is not available</h1>
      <p className="max-w-xl text-md text-text-muted">
        It does not exist, belongs to another session, or was deleted: demo runs are deleted after 7
        days.
      </p>
      <div className="flex gap-3">
        <Link
          href="/?focus=mission"
          className="inline-flex h-9 items-center rounded-md bg-accent px-4 text-sm font-medium text-accent-fg hover:bg-accent/90"
        >
          New run
        </Link>
        <Link
          href="/runs"
          className="inline-flex h-9 items-center rounded-md px-3 text-sm text-text-muted hover:bg-surface-2 hover:text-text"
        >
          Your runs
        </Link>
      </div>
    </div>
  );
}

function Skeleton({ target, simulated }: { target: string | null; simulated: boolean }) {
  return (
    <div className="border-b border-border">
      <div className="mx-auto flex max-w-[96rem] flex-wrap items-center gap-3 px-4 py-4 md:px-6">
        <Eyebrow>Company X-ray</Eyebrow>
        <span aria-hidden="true" className="text-text-subtle">
          /
        </span>
        <h1 className="font-mono text-base font-medium">{target ?? "run"}</h1>
        {simulated ? (
          <span className="rounded-sm bg-warning-soft px-1.5 font-mono text-2xs text-warning">
            Simulated
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function RunView({ runId, target, simulated }: RunViewProps) {
  const { events, stream, liveFromSeq, malformed, reconnect } = useRunStream(runId);
  const view = useMemo(() => (events.length === 0 ? null : buildRunView(events)), [events]);
  const ready = view?.ok === true ? view : null;
  const active = ready !== null && ready.outcome === null;
  const running = ready?.outcome === null || ready === null;
  const now = useNow(active);
  const [chosenTab, setChosenTab] = useState<TabId | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const tabRefs = useRef<Record<TabId, HTMLButtonElement | null>>({
    plan: null,
    activity: null,
    brief: null,
  });

  if (stream.phase === "not_found") return <UnknownRun />;

  const briefParsed =
    ready?.brief?.content === undefined || ready.brief.content === null
      ? null
      : parseBrief(ready.brief.content);
  const hasBrief = ready?.brief !== null && ready?.brief !== undefined;
  const tab: TabId = chosenTab ?? (hasBrief ? "brief" : "activity");

  const stop = () => {
    setStopping(true);
    setStopError(null);
    void fetch(`/api/runs/${runId}/cancel`, { method: "POST" }).then(
      (response) => {
        setStopping(false);
        if (!response.ok && response.status !== 409) setStopError("Could not stop the run.");
      },
      () => {
        setStopping(false);
        setStopError("Could not reach the server to stop the run.");
      },
    );
  };

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const next = TABS[(index + delta + TABS.length) % TABS.length];
    if (next === undefined) return;
    setChosenTab(next.id);
    tabRefs.current[next.id]?.focus();
  };

  const input =
    ready?.url === null || ready?.url === undefined
      ? null
      : (() => {
          const created = events[0];
          const focus =
            created?.type === "run.created" && typeof created.payload.input.focus === "string"
              ? created.payload.input.focus
              : undefined;
          return focus === undefined ? { url: ready.url } : { url: ready.url, focus };
        })();

  return (
    <div className="flex flex-col">
      {ready === null ? (
        <Skeleton target={target} simulated={simulated} />
      ) : (
        <RunTopBar view={ready} now={now} onStop={stop} stopping={stopping} stopError={stopError} />
      )}

      <div className="mx-auto flex w-full max-w-[96rem] flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
        <div aria-live="polite" className="flex flex-col gap-3">
          <StreamBanner stream={stream} onReconnect={reconnect} />
          {ready?.outcome === null || ready?.outcome === undefined ? null : (
            <OutcomeBanner
              outcome={ready.outcome}
              durationMs={elapsedMs(ready.createdAt, ready.finishedAt, now)}
              brief={briefParsed?.ok === true ? briefParsed.brief : null}
              input={input}
            />
          )}
        </div>
        {view?.ok === false ? (
          <div
            role="alert"
            className="rounded-lg border border-danger/40 bg-danger-soft/40 px-4 py-3 text-sm"
          >
            <p className="font-medium text-danger">The event log could not be rebuilt</p>
            <p className="font-mono text-xs text-text-muted">{view.error}</p>
          </div>
        ) : null}
        {malformed > 0 ? (
          <p className="font-mono text-2xs text-warning">
            {malformed} event{malformed === 1 ? "" : "s"} failed validation and were skipped.
          </p>
        ) : null}

        <div
          role="tablist"
          aria-label="Run panels"
          className="flex rounded-lg border border-border bg-surface-2 p-1 md:hidden"
        >
          {TABS.map((item, index) => (
            <button
              key={item.id}
              ref={(node) => {
                tabRefs.current[item.id] = node;
              }}
              type="button"
              role="tab"
              id={`tab-${item.id}`}
              aria-selected={tab === item.id}
              aria-controls={`panel-${item.id}`}
              tabIndex={tab === item.id ? 0 : -1}
              onClick={() => {
                setChosenTab(item.id);
              }}
              onKeyDown={(event) => {
                onTabKey(event, index);
              }}
              className={cn(
                "h-8 flex-1 rounded-md text-sm font-medium transition-colors",
                tab === item.id
                  ? "bg-surface text-text shadow-sm"
                  : "text-text-muted hover:text-text",
              )}
            >
              {item.label}
              {item.id === "brief" && hasBrief && tab !== "brief" ? (
                <span
                  aria-hidden="true"
                  className="ml-1.5 inline-block size-1.5 rounded-full bg-accent align-middle"
                />
              ) : null}
            </button>
          ))}
        </div>

        <div className="grid gap-6 md:grid-cols-[13rem_minmax(0,1fr)_minmax(0,1fr)] xl:grid-cols-[16rem_minmax(0,1fr)_minmax(0,1.15fr)] xl:gap-8">
          <div
            id="panel-plan"
            role="tabpanel"
            aria-labelledby="tab-plan"
            className={cn(tab === "plan" ? "block" : "hidden", "md:block")}
          >
            <PlanPanel
              steps={ready?.steps ?? []}
              now={now}
              waiting={running}
              planVersion={ready?.state.plan?.version ?? null}
            />
          </div>
          <div
            id="panel-activity"
            role="tabpanel"
            aria-labelledby="tab-activity"
            className={cn(tab === "activity" ? "block" : "hidden", "md:block")}
          >
            <ActivityLane
              items={ready?.activity ?? []}
              liveFromSeq={liveFromSeq}
              waiting={running}
            />
          </div>
          <div
            id="panel-brief"
            role="tabpanel"
            aria-labelledby="tab-brief"
            className={cn(tab === "brief" ? "block" : "hidden", "md:block")}
          >
            <BriefPanel
              artifact={ready?.brief ?? null}
              target={ready?.target ?? target}
              running={running}
            />
          </div>
        </div>

        <p className="border-t border-border pt-4 text-xs text-text-subtle">
          Demo runs are deleted after 7 days. Everything on this page is rebuilt from the run’s
          event log
          {ready?.execution === "simulated"
            ? "; this run used the simulated dev runner, so nothing was researched and no model was called."
            : "."}
        </p>
      </div>
    </div>
  );
}
