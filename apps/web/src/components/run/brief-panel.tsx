"use client";

import { Check, Copy, Download, FileWarning } from "lucide-react";
import { useId, useMemo, useState } from "react";

import {
  type Brief,
  briefToMarkdown,
  type CitationTarget,
  citationIndex,
  orderedSections,
  parseBrief,
  sectionRows,
} from "@/lib/runs/brief";
import type { BriefArtifact } from "@/lib/runs/run-view";
import { cn } from "@/lib/utils";

import { actionButton, Chip, Eyebrow } from "./primitives";

function Citations({
  citations,
  index,
}: {
  citations: readonly string[];
  index: Map<string, CitationTarget>;
}) {
  return citations.map((sourceId) => {
    const marker = index.get(sourceId);
    return marker === undefined ? null : <CitationMarker key={sourceId} target={marker} />;
  });
}

export function CitationMarker({ target }: { target: CitationTarget }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const quote = target.source?.quotes[0];
  return (
    <span
      className="relative inline-block align-super"
      onMouseEnter={() => {
        setOpen(true);
      }}
      onMouseLeave={() => {
        setOpen(false);
      }}
    >
      <button
        type="button"
        aria-describedby={id}
        aria-label={`Citation ${target.number}`}
        onFocus={() => {
          setOpen(true);
        }}
        onBlur={() => {
          setOpen(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
        className={cn(
          "ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-xs px-1 font-mono text-2xs leading-none tabular transition-colors",
          target.source === null
            ? "bg-danger-soft text-danger"
            : "bg-accent-soft text-accent hover:bg-accent hover:text-accent-fg",
        )}
      >
        {target.number}
      </button>
      <span
        role="tooltip"
        id={id}
        className={cn(
          "absolute bottom-full left-1/2 z-40 mb-1.5 w-72 max-w-[80vw] -translate-x-1/2 flex-col gap-1 rounded-lg border border-border-strong bg-surface p-3 text-left align-baseline font-sans text-xs leading-4 shadow-lg",
          open ? "flex" : "hidden",
        )}
      >
        {target.source === null ? (
          <span className="text-danger">
            Source <span className="font-mono">{target.sourceId}</span> is missing from the sources
            list, so this citation cannot be verified.
          </span>
        ) : (
          <>
            <span className="font-medium text-text">
              {target.source.title || target.source.url}
            </span>
            <span className="font-mono text-2xs text-text-muted">
              {target.host ?? target.source.url}
            </span>
            {quote === undefined ? (
              <span className="text-text-subtle">No quoted span recorded.</span>
            ) : (
              <span className="border-l-2 border-accent pl-2 text-text-muted">“{quote}”</span>
            )}
          </>
        )}
      </span>
    </span>
  );
}

export function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

function Exports({
  brief,
  heading,
  fileStem,
}: {
  brief: Brief;
  heading: string;
  fileStem: string;
}) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        className={actionButton}
        onClick={() => {
          navigator.clipboard.writeText(briefToMarkdown(brief, heading)).then(
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
          download(`${fileStem}.json`, JSON.stringify(brief, null, 2), "application/json");
        }}
      >
        <Download className="size-3.5" aria-hidden="true" />
        JSON
      </button>
      <span aria-live="polite" className="sr-only">
        {copied === "copied" ? "Brief copied as Markdown" : ""}
      </span>
    </div>
  );
}

export function BriefPanel({
  artifact,
  target,
  running,
}: {
  artifact: BriefArtifact | null;
  target: string | null;
  running: boolean;
}) {
  const parsed = useMemo(
    () => (artifact === null || artifact.content === null ? null : parseBrief(artifact.content)),
    [artifact],
  );
  const brief = parsed?.ok === true ? parsed.brief : null;
  const index = useMemo(
    () => (brief === null ? new Map<string, CitationTarget>() : citationIndex(brief)),
    [brief],
  );
  const heading = `Company X-ray: ${target ?? "unknown"}`;

  return (
    <section aria-labelledby="brief-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h2 id="brief-heading">
            <Eyebrow>Brief</Eyebrow>
          </h2>
          {artifact === null ? null : (
            <span className="font-mono text-2xs text-text-subtle">v{artifact.version}</span>
          )}
        </div>
        {brief === null ? null : (
          <Exports brief={brief} heading={heading} fileStem={`xray-${target ?? "brief"}`} />
        )}
      </div>

      {artifact === null || artifact.content === null ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-text-muted">
          {running
            ? "The brief renders here section by section as the editor writes it."
            : "This run produced no brief."}
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
            match the brief schema, so it is not rendered. Nothing was guessed.
          </p>
          <ul className="font-mono text-2xs text-text-muted">
            {parsed.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      ) : brief === null ? null : (
        <article className="flex flex-col gap-6">
          <div className="flex flex-col gap-1">
            <h3 className="font-serif text-xl tracking-display text-text">{artifact.title}</h3>
            {brief.company.oneLiner === null ? null : (
              <p className="text-sm leading-6 text-text-muted">
                {brief.company.oneLiner.text}
                <Citations citations={brief.company.oneLiner.citations} index={index} />
              </p>
            )}
            {brief.status === "draft" ? (
              <Chip tone="neutral" className="w-fit">
                draft
              </Chip>
            ) : null}
          </div>
          {orderedSections(brief).map(({ key, title, section }) => (
            <section key={key} aria-labelledby={`brief-${key}`} className="flex flex-col gap-2">
              <h4 id={`brief-${key}`} className="text-sm font-medium text-text">
                {title}
              </h4>
              {section === null ? (
                running ? (
                  <div aria-hidden="true" className="flex flex-col gap-1.5">
                    <span className="h-3 w-11/12 rounded-sm bg-surface-2 motion-safe:animate-pulse" />
                    <span className="h-3 w-2/3 rounded-sm bg-surface-2 motion-safe:animate-pulse" />
                  </div>
                ) : (
                  <p className="text-sm text-text-subtle">Not covered in this run.</p>
                )
              ) : section.status === "ok" ? (
                <ul className="flex flex-col gap-1.5">
                  {sectionRows(section).map((row, position) => (
                    <li key={`${key}-${String(position)}`} className="text-sm leading-6 text-text">
                      {row.label === null ? null : (
                        <span className="mr-1.5 font-medium text-text">{row.label}:</span>
                      )}
                      {row.claim.text}
                      <Citations citations={row.claim.citations} index={index} />
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="flex flex-col gap-1 rounded-md border border-border bg-surface-2/60 px-3 py-2">
                  <Chip tone="neutral" className="w-fit">
                    Insufficient evidence
                  </Chip>
                  <p className="text-sm text-text-muted">{section.note}</p>
                </div>
              )}
            </section>
          ))}
          <section
            aria-labelledby="brief-sources"
            className="flex flex-col gap-2 border-t border-border pt-4"
          >
            <h4 id="brief-sources" className="text-sm font-medium text-text">
              Sources{" "}
              <span className="font-mono text-2xs text-text-subtle">{brief.sources.length}</span>
            </h4>
            {brief.sources.length === 0 ? (
              <p className="text-sm text-text-subtle">No sources recorded yet.</p>
            ) : (
              <ol className="flex flex-col gap-2">
                {brief.sources.map((source) => {
                  const number = index.get(source.sourceId)?.number;
                  return (
                    <li key={source.sourceId} className="flex gap-2 text-sm">
                      <span className="w-5 shrink-0 font-mono text-2xs leading-5 text-text-subtle tabular">
                        {number ?? "–"}
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
                  );
                })}
              </ol>
            )}
          </section>
        </article>
      )}
    </section>
  );
}
