"use client";

import { AUTOPILOT_LIMITS } from "@delegate/runtime";
import { Square, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import {
  autopilotGoal,
  autopilotNodes,
  autopilotReport,
  foldSafely,
  formatMinutes,
  type LiveStatuses,
  liveStatuses,
} from "@/lib/runs/autopilot";

import { AutopilotReportPanel, MissionGraph } from "./autopilot-panel";
import { actionButton, Chip, Eyebrow, useNow } from "./primitives";
import { Banner, StreamBanner } from "./run-status";
import { useRunStream } from "./use-run-stream";

export const CHILD_POLL_MS = 3_000;

function useLiveChildren(runId: string, active: boolean, seq: number): LiveStatuses {
  const [live, setLive] = useState<LiveStatuses>({});
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void fetch(`/api/runs/${runId}/children`, { headers: { accept: "application/json" } })
        .then((response) => (response.ok ? response.json() : null))
        .then((body: unknown) => {
          if (!cancelled && body !== null) setLive(liveStatuses(body));
        })
        .catch(() => undefined);
    };
    load();
    if (!active)
      return () => {
        cancelled = true;
      };
    const timer = setInterval(load, CHILD_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [runId, active, seq]);
  return live;
}

export function AutopilotView({ runId, simulated }: { runId: string; simulated: boolean }) {
  const { events, stream, reconnect } = useRunStream(runId);
  const state = useMemo(() => foldSafely(events), [events]);
  const terminal = state?.status === "completed" || state?.status === "failed";
  const live = useLiveChildren(runId, state !== null && !terminal, state?.children.length ?? 0);
  const nodes = useMemo(() => (state === null ? [] : autopilotNodes(state, live)), [state, live]);
  const report = useMemo(() => autopilotReport(events), [events]);
  const goal = autopilotGoal(events);
  const now = useNow(state !== null && !terminal);
  const startedAt = events[0] === undefined ? null : Date.parse(events[0].at);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);

  if (stream.phase === "not_found")
    return (
      <div className="mx-auto flex max-w-content flex-col gap-4 px-6 pt-16 pb-24">
        <Eyebrow>Autopilot · 404</Eyebrow>
        <h1 className="font-serif text-display-sm tracking-display">This run is not available</h1>
        <Link href="/runs" className="text-sm text-accent hover:underline">
          Your runs
        </Link>
      </div>
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

  const deciding =
    state !== null &&
    !terminal &&
    state.children.length <= 1 &&
    nodes.every((node) => node.nodeId === "brief");
  const waitingNode = nodes.find(
    (node) => node.status === "awaiting_plan_approval" || node.status === "awaiting_approval",
  );

  return (
    <div className="flex flex-col">
      <div className="border-b border-border">
        <div className="mx-auto flex max-w-[96rem] flex-col gap-2 px-4 py-4 md:px-6">
          <div className="flex flex-wrap items-center gap-2">
            <Eyebrow>Autopilot</Eyebrow>
            {simulated ? (
              <span className="rounded-sm bg-warning-soft px-1.5 font-mono text-2xs text-warning">
                Simulated
              </span>
            ) : null}
            {state === null ? null : (
              <Chip
                tone={
                  state.status === "completed"
                    ? "success"
                    : state.status === "failed"
                      ? "danger"
                      : "accent"
                }
              >
                {terminal ? state.status : "working"}
              </Chip>
            )}
            {startedAt === null ? null : (
              <span className="font-mono text-2xs text-text-subtle tabular">
                {formatMinutes((terminal ? Date.parse(events.at(-1)?.at ?? "") : now) - startedAt)}{" "}
                of {formatMinutes(AUTOPILOT_LIMITS.maxWallMs)}
              </span>
            )}
            {state !== null && !terminal ? (
              <button
                type="button"
                onClick={stop}
                disabled={stopping}
                className={`${actionButton} ml-auto`}
              >
                <Square className="size-3.5" aria-hidden="true" />
                {stopping ? "Stopping…" : "Stop"}
              </button>
            ) : null}
          </div>
          <h1 className="max-w-4xl font-serif text-display-sm tracking-display text-balance">
            {goal ?? "Autopilot run"}
          </h1>
          {stopError === null ? null : (
            <p role="alert" className="text-sm text-danger">
              {stopError}
            </p>
          )}
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-[96rem] flex-col gap-5 px-4 py-4 md:px-6 md:py-6">
        <div aria-live="polite" className="flex flex-col gap-3">
          <StreamBanner stream={stream} onReconnect={reconnect} />
          {waitingNode?.runId === null || waitingNode === undefined ? null : (
            <Banner
              tone="warning"
              icon={<TriangleAlert className="size-4" />}
              title={`${waitingNode.label} is waiting for you`}
              action={
                <Link href={`/runs/${waitingNode.runId}`} className={actionButton}>
                  Open {waitingNode.label}
                </Link>
              }
            >
              Autopilot never approves on your behalf. Decide on the child run’s page; Autopilot
              continues when it finishes.
            </Banner>
          )}
          {state === null && events.length > 0 ? (
            <Banner
              tone="danger"
              icon={<TriangleAlert className="size-4" />}
              title="The event log could not be rebuilt"
            />
          ) : null}
          {state?.status === "failed" && report === null && state.error !== undefined ? (
            <Banner
              tone="danger"
              icon={<TriangleAlert className="size-4" />}
              title="Autopilot stopped"
            >
              {state.error.message}
            </Banner>
          ) : null}
        </div>

        {state === null ? null : <MissionGraph nodes={nodes} deciding={deciding} />}
        {report === null ? null : <AutopilotReportPanel report={report} />}

        <p className="border-t border-border pt-4 text-xs text-text-subtle">
          Autopilot launches at most {AUTOPILOT_LIMITS.maxChildren} child runs, one at a time, and
          stops on the first failure. Every child is an ordinary run with its own plan, approvals
          and event log; this page is rebuilt from the Autopilot run’s log.
        </p>
      </div>
    </div>
  );
}
