"use client";

import Link from "next/link";
import { type KeyboardEvent, useEffect, useMemo, useReducer, useRef, useState } from "react";

import { parseBrief } from "@/lib/runs/brief";
import {
  initialReplayState,
  replayClock,
  replayDelayMs,
  replayFrame,
  replayReducer,
} from "@/lib/runs/replay";
import { buildRunView, elapsedMs } from "@/lib/runs/run-view";
import { cn } from "@/lib/utils";

import { missionLabel, type RunnableMissionId } from "@/lib/m2-contract";

import { AgentLanes } from "./agent-lanes";
import { AuditPanel } from "./audit-panel";
import { BriefPanel } from "./brief-panel";
import { BuildAgentPanel } from "./build-agent-panel";
import { ForkBanner } from "./fork-banner";
import { ForkButton, ForkPanel } from "./fork-panel";
import { NextActions, nextActionsFor } from "./next-actions";
import { PlanApprovalCard } from "./plan-approval-card";
import { PlanPanel } from "./plan-panel";
import { PlaybookChip } from "./playbook-chip";
import { Eyebrow, useNow } from "./primitives";
import { ReplayBar, ReplayButton } from "./replay-bar";
import { OutcomeBanner, ResumedBanner, StreamBanner } from "./run-status";
import { RunTopBar } from "./run-top-bar";
import { SummaryStrip } from "./summary-strip";
import { useRunStream } from "./use-run-stream";

type TabId = "plan" | "activity" | "brief";

export interface RunViewProps {
  runId: string;
  target: string | null;
  simulated: boolean;
  missionId: string;
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

function Skeleton({
  target,
  simulated,
  missionId,
}: {
  target: string | null;
  simulated: boolean;
  missionId: string;
}) {
  return (
    <div className="border-b border-border">
      <div className="mx-auto flex max-w-[96rem] flex-wrap items-center gap-3 px-4 py-4 md:px-6">
        <Eyebrow>{missionLabel(missionId)}</Eyebrow>
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

function isRunnable(id: string): id is RunnableMissionId {
  return id === "company-xray" || id === "automation-audit" || id === "build-agent";
}

function optionalText(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function RunView({ runId, target, simulated, missionId }: RunViewProps) {
  const { events: recorded, stream, liveFromSeq, malformed, reconnect } = useRunStream(runId);
  const [replay, dispatchReplay] = useReducer(replayReducer, initialReplayState);
  const [forking, setForking] = useState(false);
  const events = useMemo(() => replayFrame(recorded, replay), [recorded, replay]);
  const view = useMemo(() => (events.length === 0 ? null : buildRunView(events)), [events]);
  const ready = view?.ok === true ? view : null;
  const active = ready !== null && ready.outcome === null;
  const running = ready?.outcome === null || ready === null;
  const liveNow = useNow(active && !replay.active);
  const now = replayClock(recorded, replay) ?? liveNow;
  const lastRecorded = recorded.at(-1);
  const finished = lastRecorded?.type === "run.completed" || lastRecorded?.type === "run.failed";

  useEffect(() => {
    if (!replay.playing) return;
    const previous = recorded[replay.cursor - 1];
    const next = recorded[replay.cursor];
    if (previous === undefined || next === undefined) return;
    const timer = setTimeout(
      () => {
        dispatchReplay({ type: "tick", total: recorded.length });
      },
      replayDelayMs(previous, next, replay.speed),
    );
    return () => {
      clearTimeout(timer);
    };
  }, [recorded, replay]);
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
  const isAudit = (ready?.missionId ?? missionId) === "automation-audit";
  const isBuild = (ready?.missionId ?? missionId) === "build-agent";
  const hasBrief =
    (ready?.brief !== null && ready?.brief !== undefined) ||
    (ready?.audit !== null && ready?.audit !== undefined) ||
    (isBuild && Object.values(ready?.state.artifacts ?? {}).some((a) => a.kind === "assistant"));
  const pendingPlan = replay.active ? null : (ready?.pendingPlan ?? null);
  const tab: TabId = chosenTab ?? (pendingPlan !== null ? "plan" : hasBrief ? "brief" : "activity");
  const TABS: { id: TabId; label: string }[] = [
    { id: "plan", label: pendingPlan === null ? "Plan" : "Approve plan" },
    { id: "activity", label: "Agents" },
    { id: "brief", label: isAudit ? "Audit" : isBuild ? "Assistant" : "Brief" },
  ];
  const actions =
    ready === null
      ? []
      : nextActionsFor(
          ready.missionId,
          ready.url,
          ready.outcome?.kind === "completed",
          ready.nextActions,
        );

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
    ready?.url === null || ready?.url === undefined || !isRunnable(ready.missionId)
      ? null
      : (() => {
          const created = events[0];
          const raw = created?.type === "run.created" ? created.payload.input : {};
          const fields = ["focus", "department", "goal", "name", "opportunityId"] as const;
          const extra = Object.fromEntries(
            fields.flatMap((key) => {
              const value = optionalText(raw, key);
              return value === undefined ? [] : [[key, value]];
            }),
          );
          const parentRunId = optionalText(raw, "parentRunId");
          return {
            missionId: ready.missionId,
            input: { url: ready.url, ...extra },
            ...(parentRunId === undefined ? {} : { parentRunId }),
          };
        })();

  return (
    <div className="flex flex-col">
      {ready === null ? (
        <Skeleton target={target} simulated={simulated} missionId={missionId} />
      ) : (
        <RunTopBar
          runId={runId}
          view={ready}
          now={now}
          onStop={stop}
          stopping={stopping}
          stopError={stopError}
          replaying={replay.active}
          actions={
            finished && !replay.active ? (
              <>
                <ReplayButton
                  onStart={() => {
                    setForking(false);
                    dispatchReplay({ type: "start", total: recorded.length });
                  }}
                />
                <ForkButton
                  onOpen={() => {
                    setForking((open) => !open);
                  }}
                />
              </>
            ) : null
          }
        />
      )}

      <div className="mx-auto flex w-full max-w-[96rem] flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
        <div aria-live="polite" data-print="hide" className="flex flex-col gap-3">
          {replay.active ? (
            <ReplayBar events={recorded} state={replay} dispatch={dispatchReplay} />
          ) : (
            <StreamBanner stream={stream} onReconnect={reconnect} />
          )}
          {forking && finished && !replay.active ? (
            <ForkPanel
              runId={runId}
              events={recorded}
              onClose={() => {
                setForking(false);
              }}
            />
          ) : null}
          <ForkBanner runId={runId} events={recorded} />
          <ResumedBanner events={events} />
          {ready?.outcome === null || ready?.outcome === undefined ? null : (
            <OutcomeBanner
              outcome={ready.outcome}
              durationMs={elapsedMs(ready.createdAt, ready.finishedAt, now)}
              brief={briefParsed?.ok === true ? briefParsed.brief : null}
              input={input}
            />
          )}
          {ready === null ? null : <SummaryStrip view={ready} events={events} />}
          {ready?.state.playbook === undefined ? null : (
            <PlaybookChip applied={ready.state.playbook} />
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
          data-print="hide"
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

        <div className="grid gap-6 md:grid-cols-[15rem_minmax(0,1fr)] lg:grid-cols-[16rem_minmax(0,1fr)_minmax(0,1.15fr)] xl:grid-cols-[18rem_minmax(0,1fr)_minmax(0,1.25fr)] xl:gap-8">
          {pendingPlan === null ? null : (
            <div
              data-print="hide"
              className={cn(
                tab === "plan" ? "block" : "hidden",
                "md:col-span-2 md:block lg:col-span-2",
              )}
            >
              <PlanApprovalCard
                key={pendingPlan.version}
                runId={runId}
                version={pendingPlan.version}
                steps={pendingPlan.steps}
              />
            </div>
          )}
          <div
            id="panel-plan"
            role="tabpanel"
            aria-labelledby="tab-plan"
            data-print="hide"
            className={cn(
              pendingPlan === null && tab === "plan" ? "block" : "hidden",
              pendingPlan === null && "md:block",
            )}
          >
            <PlanPanel
              versions={ready?.planVersions ?? []}
              steps={ready?.steps ?? []}
              now={now}
              waiting={running}
              approval={ready?.planApproval ?? null}
            />
          </div>
          <div
            id="panel-activity"
            role="tabpanel"
            aria-labelledby="tab-activity"
            data-print="hide"
            className={cn(
              tab === "activity" ? "block" : "hidden",
              pendingPlan === null && "md:block",
            )}
          >
            <AgentLanes
              lanes={ready?.lanes ?? []}
              liveFromSeq={replay.active ? 0 : liveFromSeq}
              waiting={running}
              now={now}
            />
          </div>
          <div
            id="panel-brief"
            role="tabpanel"
            aria-labelledby="tab-brief"
            data-print="full"
            className={cn(
              tab === "brief" ? "block" : "hidden",
              "flex-col gap-4 md:col-span-2 md:flex lg:col-span-1",
              tab === "brief" && "flex",
            )}
          >
            <NextActions runId={runId} actions={actions} />
            {isBuild ? (
              <BuildAgentPanel events={events} running={running} />
            ) : isAudit ? (
              <AuditPanel
                runId={runId}
                buildActions={actions}
                artifact={ready?.audit ?? null}
                target={ready?.target ?? target}
                running={running}
                unverified={
                  ready !== null && ready.outcome !== null && ready.outcome.kind !== "completed"
                }
              />
            ) : (
              <BriefPanel
                artifact={ready?.brief ?? null}
                target={ready?.target ?? target}
                running={running}
              />
            )}
          </div>
        </div>

        <p data-print="hide" className="border-t border-border pt-4 text-xs text-text-subtle">
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
