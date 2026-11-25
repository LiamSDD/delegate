"use client";

import { ArrowRight, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { type NextAction, RUNNABLE_MISSION_IDS, type RunnableMissionId } from "@/lib/m2-contract";
import { startRun } from "@/lib/runs/start-run";

import { BuildItButton } from "./build-it-button";
import { Eyebrow, primaryButton } from "./primitives";

function isRunnable(id: string): id is RunnableMissionId {
  return id !== "build-agent" && (RUNNABLE_MISSION_IDS as readonly string[]).includes(id);
}

export function nextActionsFor(
  missionId: string,
  url: string | null,
  completed: boolean,
  reported: readonly NextAction[],
): NextAction[] {
  if (reported.length > 0) return [...reported];
  if (missionId === "company-xray" && completed && url !== null) {
    return [
      {
        id: "run-automation-audit",
        missionId: "automation-audit",
        input: { url },
        label: "Run AI Automation Audit",
        available: true,
      },
    ];
  }
  return [];
}

export function NextActions({ runId, actions }: { runId: string; actions: readonly NextAction[] }) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runnable = actions.filter((action) => isRunnable(action.missionId));
  const builds = actions.filter((action) => action.missionId === "build-agent" && action.available);
  const topBuild = builds[0];
  if (runnable.length === 0 && builds.length === 0) return null;

  return (
    <div
      data-print="hide"
      className="flex flex-col gap-3 rounded-xl border border-border bg-surface-2/50 px-4 py-3"
    >
      <Eyebrow>Next actions</Eyebrow>
      <div className="flex flex-wrap items-center gap-2">
        {runnable.map((action) => {
          const url = typeof action.input.url === "string" ? action.input.url : null;
          const key = action.id;
          return (
            <button
              key={key}
              type="button"
              disabled={!action.available || url === null || pending !== null}
              title={action.description}
              onClick={() => {
                if (url === null || !isRunnable(action.missionId)) return;
                setPending(key);
                setError(null);
                void startRun({
                  missionId: action.missionId,
                  input: { url },
                  parentRunId: runId,
                }).then((result) => {
                  if (result.ok) {
                    router.push(`/runs/${result.runId}`);
                    return;
                  }
                  setPending(null);
                  setError(result.message);
                });
              }}
              className={primaryButton}
            >
              {pending === key ? (
                <RefreshCw className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
              ) : null}
              {action.label}
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </button>
          );
        })}
        {topBuild === undefined ? null : (
          <>
            <BuildItButton
              action={topBuild}
              runId={runId}
              primary
              label={`Build it: ${typeof topBuild.input.name === "string" ? topBuild.input.name : "top opportunity"}`}
            />
            {builds.length > 1 ? (
              <span className="font-mono text-2xs text-text-subtle">
                +{builds.length - 1} more on the opportunity cards
              </span>
            ) : null}
          </>
        )}
      </div>
      {error === null ? null : (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
