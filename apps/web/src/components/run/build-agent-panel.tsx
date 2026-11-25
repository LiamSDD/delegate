"use client";

import { FileWarning } from "lucide-react";
import { useMemo } from "react";

import type { RunEvent } from "@delegate/runtime";

import { buildAgentDeliverables } from "@/lib/runs/build-agent";

import { AssistantCard, EvalResults, GapsList } from "../agents/deliverables";
import { Eyebrow } from "./primitives";

export function BuildAgentPanel({
  events,
  running,
}: {
  events: readonly RunEvent[];
  running: boolean;
}) {
  const deliverables = useMemo(() => buildAgentDeliverables(events), [events]);
  const { assistant, evals, gaps, invalid } = deliverables;

  return (
    <section aria-labelledby="build-heading" className="flex flex-col gap-5">
      <h2 id="build-heading">
        <Eyebrow>Assistant</Eyebrow>
      </h2>
      {invalid.length === 0 ? null : (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger-soft/40 px-3 py-2.5 text-sm"
        >
          <FileWarning className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
          <p className="text-text">
            {invalid.join(", ")} did not match the expected schema, so it is not rendered. Nothing
            was guessed.
          </p>
        </div>
      )}
      {assistant === null ? (
        <div className="flex flex-col gap-3 rounded-lg border border-dashed border-border px-4 py-6 text-sm text-text-muted">
          {running
            ? "The site is crawled within its robots.txt, chunked and indexed; the assistant card appears once it is designed."
            : "This run produced no assistant."}
          {running ? (
            <div aria-hidden="true" className="flex flex-col gap-2">
              <span className="h-28 rounded-lg bg-surface-2 motion-safe:animate-pulse" />
            </div>
          ) : null}
        </div>
      ) : (
        <AssistantCard assistant={assistant} passRate={evals?.passRate} />
      )}
      <div className="flex flex-col gap-2">
        <Eyebrow>Evals</Eyebrow>
        <EvalResults evals={evals} running={running} />
      </div>
      <div className="flex flex-col gap-2">
        <Eyebrow>Gaps found</Eyebrow>
        <GapsList gaps={gaps} running={running} />
      </div>
    </section>
  );
}
