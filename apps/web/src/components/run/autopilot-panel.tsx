"use client";

import type { AutopilotReport, RunEvent } from "@delegate/runtime";
import { ArrowRight, ExternalLink, Workflow } from "lucide-react";
import Link from "next/link";

import {
  approvalNote,
  autopilotParent,
  formatMinutes,
  type GraphNode,
  NODE_STATUS,
} from "@/lib/runs/autopilot";
import { cn } from "@/lib/utils";

import { Chip, Eyebrow } from "./primitives";
import { Banner } from "./run-status";

const linkButton =
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md border border-border bg-surface px-3 text-sm font-medium text-text shadow-sm transition-colors hover:border-border-strong";

function isExternal(href: string): boolean {
  return /^https?:\/\//.test(href);
}

function DeliverableLink({ label, href }: { label: string; href: string }) {
  return isExternal(href) ? (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-1 text-sm text-accent underline-offset-2 hover:underline"
    >
      {label}
      <ExternalLink className="size-3" aria-hidden="true" />
    </a>
  ) : (
    <Link href={href} className="text-sm text-accent underline-offset-2 hover:underline">
      {label}
    </Link>
  );
}

function NodeCard({ node, index }: { node: GraphNode; index: number }) {
  const status = NODE_STATUS[node.status];
  const note = approvalNote(node.approvals);
  return (
    <li
      data-node={node.nodeId}
      data-status={node.status}
      className={cn(
        "relative flex min-w-0 flex-col gap-2 rounded-lg border bg-surface p-3",
        node.status === "queued" ? "border-dashed border-border" : "border-border-strong",
        (node.status === "awaiting_plan_approval" || node.status === "awaiting_approval") &&
          "border-warning/60",
        node.status === "failed" && "border-danger/50",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-2xs text-text-subtle tabular">
          {String(index + 1).padStart(2, "0")}
        </span>
        <Chip tone={status.tone}>
          {status.live ? (
            <span
              aria-hidden="true"
              className="inline-block size-1.5 animate-pulse rounded-full bg-current"
            />
          ) : null}
          {status.label}
        </Chip>
      </div>
      <p className="text-sm font-medium text-text">{node.label}</p>
      {node.handoff === null ? null : (
        <p className="text-xs text-text-muted">
          <span className="text-text-subtle">From </span>
          {node.handoff}
        </p>
      )}
      {node.summary === null ? null : (
        <p className="line-clamp-3 text-xs text-text-muted" title={node.summary}>
          {node.summary}
        </p>
      )}
      {node.metrics.length === 0 ? null : (
        <dl className="flex flex-wrap gap-x-3 gap-y-1">
          {node.metrics.map((metric) => (
            <div key={metric.label} className="flex gap-1 text-xs">
              <dt className="text-text-subtle">{metric.label}</dt>
              <dd className="font-mono text-text tabular">{metric.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-1">
        {node.runId === null ? (
          <span className="text-xs text-text-subtle">Starts when the step before it is done</span>
        ) : (
          <Link
            href={`/runs/${node.runId}`}
            className="text-sm font-medium text-accent underline-offset-2 hover:underline"
          >
            {node.status === "awaiting_plan_approval" ? "Review the plan" : "Open run"}
          </Link>
        )}
        {node.links.map((link) => (
          <DeliverableLink key={link.href} label={link.label} href={link.href} />
        ))}
      </div>
      {note === null ? null : <p className="font-mono text-2xs text-text-subtle">{note}</p>}
    </li>
  );
}

export function MissionGraph({
  nodes,
  deciding,
}: {
  nodes: readonly GraphNode[];
  deciding: boolean;
}) {
  return (
    <section aria-labelledby="mission-graph" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="mission-graph" className="text-sm font-medium text-text">
          Mission graph
        </h2>
        <Eyebrow>
          {nodes.filter((node) => node.runId !== null).length} of {nodes.length} launched
        </Eyebrow>
      </div>
      <ol className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {nodes.map((node, index) => (
          <NodeCard key={node.nodeId} node={node} index={index} />
        ))}
      </ol>
      {deciding ? (
        <p className="flex items-center gap-1.5 text-xs text-text-muted">
          <ArrowRight className="size-3.5" aria-hidden="true" />
          The next missions are chosen from the brief’s ranked actions when it is done.
        </p>
      ) : null}
    </section>
  );
}

const REPORT_TONE: Record<AutopilotReport["status"], "success" | "warning" | "danger"> = {
  completed: "success",
  stopped: "warning",
  failed: "danger",
};

export function AutopilotReportPanel({ report }: { report: AutopilotReport }) {
  return (
    <section
      aria-labelledby="autopilot-report"
      className="flex flex-col gap-5 rounded-lg border border-border bg-surface p-4 md:p-5"
    >
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="autopilot-report" className="font-serif text-xl tracking-display">
            Autopilot report
          </h2>
          <Chip tone={REPORT_TONE[report.status]}>{report.status}</Chip>
          {report.tier === "guest" ? <Chip>demo visitor: read-only and patches</Chip> : null}
        </div>
        <p className="text-md text-text text-pretty">{report.headline}</p>
      </div>

      <div className="flex flex-col gap-2">
        <Eyebrow>What was done</Eyebrow>
        <ol className="flex flex-col divide-y divide-border rounded-md border border-border">
          {report.steps.map((step) => (
            <li key={step.nodeId} className="flex flex-col gap-1 px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-text">{step.label}</span>
                <Chip
                  tone={
                    step.status === "completed"
                      ? "success"
                      : step.status === "failed"
                        ? "danger"
                        : "neutral"
                  }
                >
                  {step.status === "not_started" ? "not started" : step.status}
                </Chip>
                {step.outcome?.metrics.map((metric) => (
                  <span key={metric.label} className="text-xs text-text-muted">
                    {metric.label} <span className="font-mono text-text">{metric.value}</span>
                  </span>
                ))}
              </div>
              {step.outcome === null ? (
                step.note === undefined ? null : (
                  <p className="text-xs text-text-subtle">{step.note}</p>
                )
              ) : (
                <p className="text-xs text-text-muted">{step.outcome.summary}</p>
              )}
              {step.outcome === null || step.outcome.links.length === 0 ? null : (
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  {step.outcome.links.map((link) => (
                    <DeliverableLink key={link.href} label={link.label} href={link.href} />
                  ))}
                </div>
              )}
            </li>
          ))}
        </ol>
      </div>

      {report.needsHuman.length === 0 ? null : (
        <div className="flex flex-col gap-2">
          <Eyebrow>Still needs a human</Eyebrow>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-text">
            {report.needsHuman.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}

      <dl className="grid grid-cols-3 gap-3 border-t border-border pt-3 text-xs">
        <div>
          <dt className="text-text-subtle">Child runs</dt>
          <dd className="font-mono text-text tabular">
            {report.usage.children} / {report.limits.maxChildren}
          </dd>
        </div>
        <div>
          <dt className="text-text-subtle">Tokens</dt>
          <dd className="font-mono text-text tabular">
            {report.usage.tokens.toLocaleString("en-US")} /{" "}
            {report.limits.maxTokens.toLocaleString("en-US")}
          </dd>
        </div>
        <div>
          <dt className="text-text-subtle">Wall time</dt>
          <dd className="font-mono text-text tabular">
            {formatMinutes(report.usage.wallMs)} / {formatMinutes(report.limits.maxWallMs)}
          </dd>
        </div>
      </dl>
    </section>
  );
}

export function AutopilotBanner({ events }: { events: readonly RunEvent[] }) {
  const parent = autopilotParent(events);
  if (parent === null) return null;
  return (
    <Banner
      tone="neutral"
      icon={<Workflow className="size-4" />}
      title={`Part of Autopilot run ${parent.parentRunId.slice(0, 8)}`}
      action={
        <Link href={`/runs/${parent.parentRunId}`} className={linkButton}>
          Autopilot run
        </Link>
      }
    >
      <span>
        Step <span className="font-mono">{parent.nodeId}</span>. This run keeps its own plan,
        approvals and deliverable; Autopilot continues when it finishes.
      </span>
    </Banner>
  );
}
