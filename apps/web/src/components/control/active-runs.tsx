import type { RunStatus } from "@delegate/runtime";
import { ArrowRight } from "lucide-react";
import Link from "next/link";

import { actionButton, Chip, type Tone } from "@/components/run/primitives";
import { missionLabel } from "@/lib/m2-contract";
import { cn } from "@/lib/utils";
import type { ActiveRun, ActiveRuns, RunSnapshot } from "@/server/control/active-runs";

import { Ago, Elapsed } from "./clock";
import { formatCount, formatSpan, shortId } from "./format";
import { EmptyState, Fact } from "./section";
import { StopRunButton } from "./stop-run-button";

export const RUN_STATUS: Record<RunStatus, { label: string; tone: Tone }> = {
  planning: { label: "Planning", tone: "accent" },
  awaiting_plan_approval: { label: "Plan needs approval", tone: "warning" },
  running: { label: "Running", tone: "accent" },
  awaiting_approval: { label: "Needs approval", tone: "warning" },
  completed: { label: "Completed", tone: "success" },
  failed: { label: "Failed or stopped", tone: "danger" },
};

function isActive(run: RunSnapshot): boolean {
  return run.status !== "completed" && run.status !== "failed";
}

function StepFact({ run }: { run: RunSnapshot }) {
  if (run.step === null) return <span className="text-text-muted">no step started yet</span>;
  return (
    <>
      {run.step.id}{" "}
      <span className="text-text-muted">
        {run.step.state === "running" ? "· in progress" : "· finished, next not started"}
      </span>
    </>
  );
}

function RunRow({
  run,
  renderedAt,
  staleAfterMs,
  nested = false,
}: {
  run: RunSnapshot;
  renderedAt: number;
  staleAfterMs: number;
  nested?: boolean;
}) {
  const status = RUN_STATUS[run.status];
  const name = run.target ?? shortId(run.id);
  const active = isActive(run);
  return (
    <div
      data-run={run.id}
      className={cn(
        "flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6",
        nested ? "py-3" : "px-4 py-4",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
          <Link
            href={`/runs/${run.id}`}
            className="min-w-0 font-mono text-sm break-all text-text underline decoration-border-strong underline-offset-4 hover:text-accent hover:decoration-accent"
          >
            {name}
          </Link>
          <Chip>{missionLabel(run.mission)}</Chip>
          <Chip tone={status.tone}>{status.label}</Chip>
          {run.execution === "simulated" ? <Chip tone="warning">Simulated</Chip> : null}
          {run.stalled ? <Chip tone="danger">Stalled</Chip> : null}
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2.5 sm:flex sm:flex-wrap sm:gap-x-8">
          <Fact label="Current step" className="col-span-2">
            <StepFact run={run} />
          </Fact>
          <Fact label={active ? "Elapsed" : "Took"}>
            {run.finishedAt === null ? (
              <Elapsed since={run.createdAt.toISOString()} renderedAt={renderedAt} />
            ) : (
              formatSpan(run.finishedAt.getTime() - run.createdAt.getTime())
            )}
          </Fact>
          <Fact label="Tokens, in + out">{formatCount(run.tokens)}</Fact>
          <Fact label="Last event">
            {run.lastEventAt === null ? (
              <span className="text-text-muted">none yet</span>
            ) : (
              <Ago at={run.lastEventAt.toISOString()} renderedAt={renderedAt} />
            )}
          </Fact>
        </dl>
        {run.stalled ? (
          <p className="max-w-2xl text-sm text-text-muted">
            Nothing logged for over {formatSpan(staleAfterMs)}. Open the run: its page revives a run
            that lost its worker, or closes it. This page only reads.
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-start gap-2">
        {active ? <StopRunButton runId={run.id} name={name} /> : null}
        <Link href={`/runs/${run.id}`} className={actionButton} aria-label={`Open run ${name}`}>
          Open run
          <ArrowRight className="size-3.5" aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}

function Parent({
  run,
  renderedAt,
  staleAfterMs,
}: {
  run: ActiveRun;
  renderedAt: number;
  staleAfterMs: number;
}) {
  return (
    <li className="border-b border-border last:border-b-0">
      <RunRow run={run} renderedAt={renderedAt} staleAfterMs={staleAfterMs} />
      {run.children.length === 0 ? null : (
        <div className="px-4 pb-3">
          <p className="font-mono text-2xs tracking-label text-text-subtle uppercase">
            Steps this Autopilot run started ({run.children.length})
          </p>
          <ol className="mt-1 flex flex-col border-l-2 border-border pl-4">
            {run.children.map((child) => (
              <li key={child.id} className="border-b border-border last:border-b-0">
                <RunRow run={child} renderedAt={renderedAt} staleAfterMs={staleAfterMs} nested />
              </li>
            ))}
          </ol>
        </div>
      )}
    </li>
  );
}

export function ActiveRunsList({
  active,
  renderedAt,
  staleAfterMs,
  limit,
}: {
  active: ActiveRuns;
  renderedAt: number;
  staleAfterMs: number;
  limit: number;
}) {
  if (active.runs.length === 0)
    return (
      <EmptyState title="No runs are active">
        A run appears here the moment it starts, with its mission, target, current step, elapsed
        time and tokens, and a Stop button. Autopilot runs list the steps they started.{" "}
        <Link href="/?focus=mission" className="text-text underline underline-offset-4">
          Start a run
        </Link>
      </EmptyState>
    );
  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col rounded-xl border border-border bg-surface shadow-sm">
        {active.runs.map((run) => (
          <Parent key={run.id} run={run} renderedAt={renderedAt} staleAfterMs={staleAfterMs} />
        ))}
      </ol>
      {active.truncated ? (
        <p className="text-sm text-text-subtle">
          Showing the newest {limit} active runs. Older ones are on the{" "}
          <Link href="/runs" className="underline underline-offset-4">
            runs page
          </Link>
          .
        </p>
      ) : null}
    </div>
  );
}
