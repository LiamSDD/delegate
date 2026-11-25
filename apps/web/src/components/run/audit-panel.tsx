"use client";

import { Check, ChevronRight, Copy, Download, FileWarning, Printer, RotateCcw } from "lucide-react";
import { useId, useMemo, useState } from "react";

import type { AutomationAudit, RoiInputKey, RoiOverrides } from "@/lib/m2-contract";
import type { NextAction } from "@/lib/m3-contract";
import {
  type AuditOverrides,
  auditCitationNumbers,
  auditToCsv,
  auditToMarkdown,
  formatEur,
  formatHours,
  formulaWithValues,
  parseAudit,
  portfolioTotal,
  type RankedOpportunity,
  rankedOpportunities,
  sliderSpecs,
} from "@/lib/runs/audit";
import type { CitationTarget } from "@/lib/runs/brief";
import type { BriefArtifact } from "@/lib/runs/run-view";
import { cn } from "@/lib/utils";

import { CitationMarker, download } from "./brief-panel";
import { BuildItButton } from "./build-it-button";
import { actionButton, Chip, Eyebrow, type Tone } from "./primitives";

const DIFFICULTY_TONE: Record<string, Tone> = {
  low: "success",
  medium: "neutral",
  high: "warning",
};

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function citationTargets(audit: AutomationAudit): Map<string, CitationTarget> {
  const numbers = auditCitationNumbers(audit);
  const targets = new Map<string, CitationTarget>();
  for (const opportunity of audit.opportunities) {
    for (const evidence of opportunity.evidence) {
      for (const sourceId of evidence.citations) {
        if (targets.has(sourceId)) continue;
        const source = audit.sources.find((entry) => entry.sourceId === sourceId) ?? null;
        targets.set(sourceId, {
          number: numbers.get(sourceId) ?? 0,
          source: source === null ? null : { ...source, quotes: [] },
          sourceId,
          host: source === null ? null : hostOf(source.url),
        });
      }
    }
  }
  return targets;
}

function Slider({
  id,
  label,
  value,
  modelValue,
  min,
  max,
  step,
  format,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  modelValue: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}) {
  const percent = max === min ? 0 : ((value - min) / (max - min)) * 100;
  const modelPercent = max === min ? 0 : ((modelValue - min) / (max - min)) * 100;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-xs text-text-muted">
          {label}
        </label>
        <span
          className={cn(
            "font-mono text-xs tabular",
            value === modelValue ? "text-text" : "text-accent",
          )}
        >
          {format(value)}
        </span>
      </div>
      <div className="relative flex h-4 items-center">
        <span
          aria-hidden="true"
          className="absolute top-1/2 h-2.5 w-px -translate-y-1/2 bg-text-subtle"
          style={{ left: `${modelPercent}%` }}
          title="Model's value"
        />
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          aria-valuetext={format(value)}
          onChange={(event) => {
            onChange(Number(event.target.value));
          }}
          className="roi-slider w-full"
          style={{ ["--fill" as string]: `${percent}%` }}
        />
      </div>
    </div>
  );
}

function OpportunityCard({
  entry,
  overrides,
  onChange,
  onReset,
  citations,
  open,
  onToggle,
  build,
}: {
  build: { action: NextAction; runId: string; primary: boolean } | null;
  entry: RankedOpportunity;
  overrides: RoiOverrides;
  onChange: (key: RoiInputKey, value: number) => void;
  onReset: () => void;
  citations: Map<string, CitationTarget>;
  open: boolean;
  onToggle: () => void;
}) {
  const { opportunity, estimate } = entry;
  const bodyId = useId();
  return (
    <li className="audit-card overflow-hidden rounded-xl border border-border bg-surface shadow-sm break-inside-avoid">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={onToggle}
        className="flex w-full flex-col gap-3 px-4 py-3.5 text-left hover:bg-surface-2/50 sm:flex-row sm:items-center"
      >
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span className="mt-0.5 font-mono text-2xs text-text-subtle tabular">
            {String(entry.rank).padStart(2, "0")}
          </span>
          <div className="flex min-w-0 flex-col gap-1.5">
            <h4 className="text-md leading-6 font-medium text-pretty text-text">
              {opportunity.title}
            </h4>
            <div className="flex flex-wrap items-center gap-1.5">
              <Chip>{opportunity.department}</Chip>
              <Chip tone={DIFFICULTY_TONE[opportunity.difficulty] ?? "neutral"}>
                {opportunity.difficulty} difficulty
              </Chip>
              {entry.edited ? <Chip tone="accent">adjusted</Chip> : null}
            </div>
          </div>
        </div>
        <div className="flex items-end gap-5 pl-7 sm:pl-0">
          <div className="flex flex-col items-end">
            <span className="font-mono text-xl leading-7 font-medium text-text tabular">
              {formatEur(estimate.eurPerMonth)}
            </span>
            <span className="font-mono text-2xs text-text-subtle">per month · est.</span>
          </div>
          <div className="flex flex-col items-end">
            <span className="font-mono text-xl leading-7 text-text-muted tabular">
              {formatHours(estimate.hoursPerMonth)}
              <span className="text-sm">h</span>
            </span>
            <span className="font-mono text-2xs text-text-subtle">hours / month</span>
          </div>
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "mb-1 size-4 shrink-0 text-text-subtle transition-transform print:hidden",
              open && "rotate-90",
            )}
          />
        </div>
      </button>

      <div
        id={bodyId}
        className={cn("border-t border-border", open ? "block" : "hidden print:block")}
      >
        <div className="grid gap-px bg-border md:grid-cols-2">
          <div className="flex flex-col gap-1 bg-surface px-4 py-3">
            <Eyebrow>Today</Eyebrow>
            <p className="text-sm leading-6 text-text">{opportunity.workflow}</p>
          </div>
          <div className="flex flex-col gap-1 bg-surface px-4 py-3">
            <Eyebrow className="text-accent">With automation</Eyebrow>
            <p className="text-sm leading-6 text-text">{opportunity.automation}</p>
          </div>
        </div>

        <div className="flex flex-col gap-4 border-t border-border bg-bg/40 px-4 py-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Eyebrow>ROI model · estimate</Eyebrow>
            {entry.edited ? (
              <button
                type="button"
                onClick={onReset}
                className="inline-flex items-center gap-1 font-mono text-2xs text-text-muted hover:text-text print:hidden"
              >
                <RotateCcw className="size-3" aria-hidden="true" />
                Reset to model&apos;s values
              </button>
            ) : null}
          </div>
          <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3 print:hidden">
            {sliderSpecs(opportunity).map((spec) => (
              <Slider
                key={spec.key}
                id={`${bodyId}-${spec.key}`}
                label={spec.label}
                value={overrides[spec.key] ?? opportunity[spec.key]}
                modelValue={opportunity[spec.key]}
                min={spec.min}
                max={Math.max(spec.max, overrides[spec.key] ?? 0)}
                step={spec.step}
                format={spec.format}
                onChange={(value) => {
                  onChange(spec.key, value);
                }}
              />
            ))}
          </div>
          <p className="rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs leading-5 break-words text-text">
            {formulaWithValues(opportunity, overrides)}
          </p>
        </div>

        <div className="grid gap-5 border-t border-border px-4 py-4 md:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Eyebrow>Evidence</Eyebrow>
            {opportunity.evidence.length === 0 ? (
              <p className="text-sm text-text-subtle">No evidence recorded.</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {opportunity.evidence.map((evidence) => (
                  <li key={evidence.text} className="text-sm leading-6 text-text">
                    {evidence.text}
                    {evidence.citations.map((sourceId) => {
                      const target = citations.get(sourceId);
                      return target === undefined ? null : (
                        <CitationMarker key={sourceId} target={target} />
                      );
                    })}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <Eyebrow>First step</Eyebrow>
            <p className="text-sm leading-6 text-text">{opportunity.firstStep}</p>
            {opportunity.integrations.length === 0 ? null : (
              <>
                <Eyebrow className="mt-2">Integrations</Eyebrow>
                <div className="flex flex-wrap gap-1.5">
                  {opportunity.integrations.map((integration) => (
                    <Chip key={integration}>{integration}</Chip>
                  ))}
                </div>
              </>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <Eyebrow>Risks</Eyebrow>
            <ul className="flex list-disc flex-col gap-1 pl-4 text-sm text-text-muted marker:text-warning">
              {opportunity.risks.map((risk) => (
                <li key={risk}>{risk}</li>
              ))}
            </ul>
          </div>
          <div className="flex flex-col gap-2">
            <Eyebrow>Assumptions</Eyebrow>
            <ul className="flex list-disc flex-col gap-1 pl-4 text-sm text-text-muted marker:text-text-subtle">
              {opportunity.assumptions.map((assumption) => (
                <li key={assumption}>{assumption}</li>
              ))}
            </ul>
          </div>
        </div>
        {build === null ? null : (
          <div className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-3 print:hidden">
            <BuildItButton action={build.action} runId={build.runId} primary={build.primary} />
            <span className="text-xs text-text-muted">
              A cited assistant trained on this company&apos;s own site, with its own evals and gaps
              report.
            </span>
          </div>
        )}
      </div>
    </li>
  );
}

function AuditExports({
  audit,
  overrides,
  heading,
  fileStem,
}: {
  audit: AutomationAudit;
  overrides: AuditOverrides;
  heading: string;
  fileStem: string;
}) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <div className="flex flex-wrap items-center gap-2 print:hidden">
      <button
        type="button"
        className={actionButton}
        onClick={() => {
          navigator.clipboard.writeText(auditToMarkdown(audit, overrides, heading)).then(
            () => {
              setCopied("copied");
              setTimeout(() => {
                setCopied("idle");
              }, 2000);
            },
            () => {
              setCopied("failed");
            },
          );
        }}
      >
        {copied === "copied" ? (
          <Check className="size-3.5 text-success" aria-hidden="true" />
        ) : (
          <Copy className="size-3.5" aria-hidden="true" />
        )}
        {copied === "copied" ? "Copied" : copied === "failed" ? "Copy failed" : "Markdown"}
      </button>
      <button
        type="button"
        className={actionButton}
        onClick={() => {
          download(`${fileStem}.csv`, auditToCsv(audit, overrides), "text/csv");
        }}
      >
        <Download className="size-3.5" aria-hidden="true" />
        CSV
      </button>
      <button
        type="button"
        className={actionButton}
        onClick={() => {
          download(
            `${fileStem}.json`,
            JSON.stringify({ ...audit, overrides }, null, 2),
            "application/json",
          );
        }}
      >
        <Download className="size-3.5" aria-hidden="true" />
        JSON
      </button>
      <button
        type="button"
        className={actionButton}
        onClick={() => {
          window.print();
        }}
      >
        <Printer className="size-3.5" aria-hidden="true" />
        Print / PDF
      </button>
      <span aria-live="polite" className="sr-only">
        {copied === "copied" ? "Audit copied as Markdown" : ""}
      </span>
    </div>
  );
}

export function AuditPanel({
  artifact,
  target,
  running,
  unverified = false,
  runId,
  buildActions = [],
}: {
  runId?: string;
  buildActions?: readonly NextAction[];
  artifact: BriefArtifact | null;
  target: string | null;
  running: boolean;
  unverified?: boolean;
}) {
  const parsed = useMemo(
    () => (artifact === null || artifact.content === null ? null : parseAudit(artifact.content)),
    [artifact],
  );
  const audit = parsed?.ok === true ? parsed.audit : null;
  const [overrides, setOverrides] = useState<Record<string, RoiOverrides>>({});
  const [openIds, setOpenIds] = useState<Record<string, boolean>>({});
  const citations = useMemo(
    () => (audit === null ? new Map<string, CitationTarget>() : citationTargets(audit)),
    [audit],
  );
  const heading = `AI Automation Audit: ${target ?? "unknown"}`;
  const ranked = audit === null ? [] : rankedOpportunities(audit, overrides);
  const total = audit === null ? null : portfolioTotal(audit, overrides);
  const model = audit === null ? null : portfolioTotal(audit, {});
  const adjusted = ranked.some((entry) => entry.edited);
  const buildFor = (entry: RankedOpportunity) => {
    const action = buildActions.find(
      (candidate) =>
        candidate.missionId === "build-agent" &&
        (candidate.opportunityId ?? candidate.input.opportunityId) === entry.opportunity.id,
    );
    return action === undefined || runId === undefined
      ? null
      : { action, runId, primary: entry.rank === 1 && !running };
  };

  return (
    <section aria-labelledby="audit-heading" className="audit-report flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h2 id="audit-heading">
            <Eyebrow>Audit</Eyebrow>
          </h2>
          {artifact === null ? null : (
            <span className="font-mono text-2xs text-text-subtle">v{artifact.version}</span>
          )}
        </div>
        {audit === null ? null : (
          <AuditExports
            audit={audit}
            overrides={overrides}
            heading={heading}
            fileStem={`audit-${target ?? "report"}`}
          />
        )}
      </div>

      {artifact === null || artifact.content === null ? (
        <div className="flex flex-col gap-3 rounded-lg border border-dashed border-border px-4 py-6 text-sm text-text-muted">
          {running
            ? "Ranked opportunities appear here with their ROI model as the editor writes them."
            : "This run produced no audit."}
          {running ? (
            <div aria-hidden="true" className="flex flex-col gap-2">
              {[0, 1, 2].map((row) => (
                <span
                  key={row}
                  className="h-14 rounded-lg bg-surface-2 motion-safe:animate-pulse"
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : parsed?.ok === false ? (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-lg border border-danger/40 bg-danger-soft/40 p-4"
        >
          <p className="flex items-center gap-2 text-sm font-medium text-danger">
            <FileWarning className="size-4" aria-hidden="true" />
            Unexpected artifact shape
          </p>
          <p className="text-sm text-text-muted">
            Version {artifact.contentVersion ?? artifact.version} of “{artifact.title}” does not
            match the audit schema, so it is not rendered. Nothing was guessed.
          </p>
          <ul className="font-mono text-2xs text-text-muted">
            {parsed.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      ) : audit === null || total === null || model === null ? null : (
        <article className="flex flex-col gap-5">
          {unverified ? (
            <div
              role="note"
              className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning-soft/50 px-3 py-2.5 text-sm"
            >
              <FileWarning className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
              <p className="text-text">
                <span className="font-medium">Unverified draft.</span>{" "}
                <span className="text-text-muted">
                  The run ended before this audit passed the critic&apos;s checks. Treat every
                  figure and claim below as unconfirmed.
                </span>
              </p>
            </div>
          ) : null}
          <header className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4 shadow-sm md:p-5">
            <div className="flex flex-col gap-1">
              <h3 className="font-serif text-xl tracking-display text-text">{heading}</h3>
              <p className="text-sm leading-6 text-pretty text-text-muted">{audit.summary}</p>
            </div>
            <div className="flex flex-wrap items-end gap-x-8 gap-y-3 border-t border-border pt-4">
              <div className="flex flex-col">
                <Eyebrow>Portfolio · per month</Eyebrow>
                <span className="font-mono text-display-sm leading-10 font-medium text-text tabular">
                  {formatEur(total.eurPerMonth)}
                </span>
              </div>
              <div className="flex flex-col">
                <Eyebrow>Hours saved · per month</Eyebrow>
                <span className="font-mono text-display-sm leading-10 text-text-muted tabular">
                  {formatHours(total.hoursPerMonth)}
                </span>
              </div>
              <div className="flex flex-col gap-1 pb-1">
                <Chip tone="warning" className="w-fit">
                  estimate
                </Chip>
                <span className="font-mono text-2xs text-text-subtle">
                  {audit.opportunities.length} opportunities
                  {adjusted ? ` · model said ${formatEur(model.eurPerMonth)}` : ""}
                </span>
              </div>
              {adjusted ? (
                <button
                  type="button"
                  onClick={() => {
                    setOverrides({});
                  }}
                  className="ml-auto inline-flex items-center gap-1 pb-1 font-mono text-2xs text-text-muted hover:text-text print:hidden"
                >
                  <RotateCcw className="size-3" aria-hidden="true" />
                  Reset all to model&apos;s values
                </button>
              ) : null}
            </div>
            <p className="font-mono text-2xs leading-4 text-text-subtle">
              Formula: {audit.formula}. Estimates, not measured savings; adjust the sliders to match
              what you know.
            </p>
          </header>

          <ol className="flex flex-col gap-2.5">
            {ranked.map((entry) => (
              <OpportunityCard
                key={entry.opportunity.id}
                entry={entry}
                overrides={overrides[entry.opportunity.id] ?? {}}
                onChange={(key, value) => {
                  setOverrides((current) => ({
                    ...current,
                    [entry.opportunity.id]: { ...current[entry.opportunity.id], [key]: value },
                  }));
                }}
                onReset={() => {
                  setOverrides((current) => {
                    const { [entry.opportunity.id]: _removed, ...rest } = current;
                    return rest;
                  });
                }}
                citations={citations}
                build={buildFor(entry)}
                open={openIds[entry.opportunity.id] ?? entry.rank === 1}
                onToggle={() => {
                  setOpenIds((current) => ({
                    ...current,
                    [entry.opportunity.id]: !(current[entry.opportunity.id] ?? entry.rank === 1),
                  }));
                }}
              />
            ))}
          </ol>

          <section
            aria-labelledby="audit-sources"
            className="flex flex-col gap-2 border-t border-border pt-4"
          >
            <h4 id="audit-sources" className="text-sm font-medium text-text">
              Sources{" "}
              <span className="font-mono text-2xs text-text-subtle">{audit.sources.length}</span>
            </h4>
            <ol className="flex flex-col gap-2">
              {audit.sources.map((source) => (
                <li key={source.sourceId} className="flex gap-2 text-sm">
                  <span className="w-5 shrink-0 font-mono text-2xs leading-5 text-text-subtle tabular">
                    {citations.get(source.sourceId)?.number ?? "–"}
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="truncate text-text underline decoration-border-strong underline-offset-4 hover:text-accent hover:decoration-accent"
                    >
                      {source.title || source.url}
                    </a>
                    <span className="font-mono text-2xs text-text-subtle">
                      {source.kind} · fetched {new Date(source.fetchedAt).toLocaleString()}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          </section>
        </article>
      )}
    </section>
  );
}
