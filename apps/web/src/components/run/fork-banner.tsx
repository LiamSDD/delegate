"use client";

import type { RunEvent } from "@delegate/runtime";
import { GitBranch, GitCompare } from "lucide-react";
import Link from "next/link";

import { FORK_TARGET_MS, forkInfo } from "@/lib/runs/fork";

import { Chip } from "./primitives";
import { Banner } from "./run-status";

const linkButton =
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md border border-border bg-surface px-3 text-sm font-medium text-text shadow-sm transition-colors hover:border-border-strong";

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

export function ForkBanner({ runId, events }: { runId: string; events: readonly RunEvent[] }) {
  const info = forkInfo(events);
  if (info === null) return null;
  const parentShort = info.parentRunId.slice(0, 8);
  return (
    <Banner
      tone="neutral"
      icon={<GitBranch className="size-4" />}
      title={`Forked from run ${parentShort} at step ${info.stepId}${info.objectiveEdited ? " with an edited objective" : ""}`}
      action={
        <>
          <Link href={`/runs/${info.parentRunId}`} className={linkButton}>
            Parent run
          </Link>
          <Link
            href={`/runs/compare?a=${encodeURIComponent(info.parentRunId)}&b=${encodeURIComponent(runId)}`}
            className={linkButton}
          >
            <GitCompare className="size-3.5" aria-hidden="true" />
            Compare with parent
          </Link>
        </>
      }
    >
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>
          {info.seededEvents} event{info.seededEvents === 1 ? "" : "s"} copied from the parent’s log
        </span>
        <span>
          {info.reusedSteps.length === 0
            ? "no earlier step reused"
            : `reused ${info.reusedSteps.join(", ")}`}
        </span>
        {info.rerunSteps.length === 0 ? null : <span>re-ran {info.rerunSteps.join(", ")}</span>}
        {info.firstNewEventMs === null ? (
          <Chip>waiting for the first new event</Chip>
        ) : (
          <span title="Time from the fork's run.created to the first event the runner wrote">
            <Chip tone={info.firstNewEventMs < FORK_TARGET_MS ? "success" : "warning"}>
              first new event {seconds(info.firstNewEventMs)}
            </Chip>{" "}
            <span className="text-2xs text-text-subtle">target under 10 s</span>
          </span>
        )}
      </span>
    </Banner>
  );
}
