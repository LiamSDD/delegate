import Link from "next/link";
import type { CSSProperties } from "react";

import type { PipelineStats } from "@/server/pipeline-stats";

export const PIPELINE_STEPS: readonly { label: string; detail: string }[] = [
  { label: "Plan", detail: "typed steps, checked in code" },
  { label: "You approve", detail: "or auto-approve" },
  { label: "Agents in parallel", detail: "web read in quarantine" },
  { label: "Every citation checked", detail: "unsupported claims removed" },
  { label: "Deliverable", detail: "cited, with next actions" },
];

const STEP_SECONDS = 1.4;

export function RunPipeline({ stats }: { stats: PipelineStats | null }) {
  const cycle = `${String(STEP_SECONDS * PIPELINE_STEPS.length)}s`;
  return (
    <section
      aria-label="What happens when you press Run"
      className="flex flex-col gap-3 border-t border-border pt-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="font-mono text-2xs tracking-label text-text-subtle uppercase">
          When you press Run
        </p>
        {stats === null ? null : (
          <Link
            href="/evals"
            className="font-mono text-2xs text-text-subtle underline-offset-4 hover:text-text hover:underline"
          >
            <span className="text-success tabular">
              {`${String(stats.attacksBlocked)}/${String(stats.attacks)}`}
            </span>{" "}
            attacks blocked · {stats.suite}
          </Link>
        )}
      </div>
      <ol className="grid grid-cols-1 gap-x-3 gap-y-2 sm:grid-cols-5">
        {PIPELINE_STEPS.map((step, index) => (
          <li
            key={step.label}
            className="relative flex items-start gap-2.5 sm:flex-col sm:gap-2"
            style={
              {
                "--pipeline-delay": `${String(index * STEP_SECONDS)}s`,
                "--pipeline-cycle": cycle,
              } as CSSProperties
            }
          >
            <span className="relative flex h-5 shrink-0 items-center sm:w-full">
              <span
                aria-hidden="true"
                className="relative z-10 flex size-5 items-center justify-center rounded-full border border-border-strong bg-surface font-mono text-2xs text-text-muted tabular motion-safe:animate-pipeline-step"
              >
                {index + 1}
              </span>
              {index < PIPELINE_STEPS.length - 1 ? (
                <span
                  aria-hidden="true"
                  className="absolute top-1/2 left-6 hidden h-px w-[calc(100%-1.25rem)] overflow-hidden bg-border sm:block"
                >
                  <span className="absolute inset-y-0 left-0 w-1/3 bg-accent opacity-0 motion-safe:animate-pipeline-flow" />
                </span>
              ) : null}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="text-sm font-medium text-text">{step.label}</span>
              <span className="text-xs text-text-muted">{step.detail}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
