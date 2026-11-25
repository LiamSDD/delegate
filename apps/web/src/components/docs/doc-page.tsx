import { ArrowLeft, ArrowRight, ArrowUpRight, ChevronDown } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { isLiveDirective, type LiveDirective } from "@/lib/docs/directives";
import { loadRedteamSummary } from "@/lib/docs/facts";
import { repoBlobUrl, repoEditUrl } from "@/lib/docs/links";
import { DOC_SECTIONS } from "@/lib/docs/manifest";
import type { DocEntry, DocsRegistry, LoadedDoc } from "@/lib/docs/registry";

import { AdrIndex } from "./adr-index";
import { ApiReference } from "./api-reference";
import { DocsToc, type TocHeading } from "./docs-toc";
import { Markdown } from "./markdown";
import { RedteamSummaryPanel } from "./redteam-summary";
import { HEADING_SCROLL_MARGIN } from "./styles";

const TOC_MIN_HEADINGS = 2;
const TOC_MAX_DEPTH = 3;

function renderDirective(name: LiveDirective, registry: DocsRegistry): ReactNode {
  switch (name) {
    case "redteam-summary":
      return <RedteamSummaryPanel summary={loadRedteamSummary()} />;
    case "adr-index":
      return <AdrIndex adrs={registry.adrs} />;
    case "openapi-reference":
      return <ApiReference />;
  }
}

function kicker(entry: DocEntry): string {
  const section = DOC_SECTIONS.find((candidate) => candidate.id === entry.section)?.title ?? "Docs";
  return entry.adr === null ? section : `${section} · Decision record ${entry.adr.number}`;
}

function PagerLink({ entry, direction }: { entry: DocEntry; direction: "previous" | "next" }) {
  const next = direction === "next";
  return (
    <Link
      href={entry.route}
      rel={next ? "next" : "prev"}
      className={`group flex flex-col gap-1 rounded-lg border border-border px-4 py-3 transition-colors hover:border-border-strong ${
        next ? "items-end text-right sm:col-start-2" : "items-start"
      }`}
    >
      <span className="inline-flex items-center gap-1.5 font-mono text-2xs tracking-label text-text-subtle uppercase">
        {next ? null : <ArrowLeft className="size-3" strokeWidth={1.5} aria-hidden="true" />}
        {next ? "Next" : "Previous"}
        {next ? <ArrowRight className="size-3" strokeWidth={1.5} aria-hidden="true" /> : null}
      </span>
      <span className="text-sm font-medium text-text group-hover:text-accent">
        {entry.adr === null ? entry.label : `ADR ${entry.adr.number}: ${entry.adr.title}`}
      </span>
    </Link>
  );
}

export function DocPage({ doc, registry }: { doc: LoadedDoc; registry: DocsRegistry }) {
  const { entry, markdown } = doc;
  const toc: TocHeading[] = markdown.headings.filter(
    (heading) => heading.depth >= 2 && heading.depth <= TOC_MAX_DEPTH,
  );
  const hasToc = toc.length >= TOC_MIN_HEADINGS;
  const { previous, next } = registry.neighbours(entry);
  const directives: Partial<Record<LiveDirective, ReactNode>> = {};
  for (const name of markdown.directives)
    if (isLiveDirective(name)) directives[name] = renderDirective(name, registry);

  return (
    <div className="xl:grid xl:grid-cols-[minmax(0,1fr)_13.5rem] xl:gap-12">
      <article className="min-w-0 max-w-[45rem]">
        <header className="flex flex-col gap-4">
          <p className="font-mono text-2xs tracking-label text-text-subtle uppercase">
            {kicker(entry)}
          </p>
          <h1
            id={markdown.titleId ?? undefined}
            className={`font-serif text-display-sm tracking-display text-balance text-text sm:text-display-md ${HEADING_SCROLL_MARGIN}`}
          >
            {doc.title}
          </h1>
        </header>
        {hasToc ? (
          <details
            data-print="hide"
            className="group mt-6 rounded-lg border border-border bg-surface xl:hidden"
          >
            <summary className="flex h-10 cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-4 text-sm text-text [&::-webkit-details-marker]:hidden">
              On this page
              <ChevronDown
                className="size-4 text-text-subtle transition-transform group-open:rotate-180"
                strokeWidth={1.5}
                aria-hidden="true"
              />
            </summary>
            <ul className="border-t border-border px-4 py-2.5">
              {toc.map((heading) => (
                <li key={heading.id}>
                  <a
                    href={`#${encodeURIComponent(heading.id)}`}
                    className={`block py-1 text-sm text-text-muted hover:text-text ${
                      heading.depth > 2 ? "pl-4" : ""
                    }`}
                  >
                    {heading.text}
                  </a>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        <div className="mt-8">
          <Markdown
            markdown={markdown}
            source={entry.source}
            registry={registry}
            directives={directives}
          />
        </div>
        <footer className="mt-14 flex flex-col gap-6 border-t border-border pt-5">
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-sm">
            <a
              href={repoEditUrl(entry.source)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-text-muted underline-offset-4 transition-colors hover:text-accent hover:underline"
            >
              Edit on GitHub
              <ArrowUpRight className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
            <a
              href={repoBlobUrl(entry.source)}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-2xs text-text-subtle underline-offset-4 transition-colors [overflow-wrap:anywhere] hover:text-text hover:underline"
            >
              {entry.source}
              <span className="sr-only"> (source file, opens on GitHub)</span>
            </a>
          </div>
          {previous === null && next === null ? null : (
            <nav
              aria-label="Previous and next page"
              data-print="hide"
              className="grid gap-3 sm:grid-cols-2"
            >
              {previous === null ? null : <PagerLink entry={previous} direction="previous" />}
              {next === null ? null : <PagerLink entry={next} direction="next" />}
            </nav>
          )}
        </footer>
      </article>
      {hasToc ? (
        <aside
          data-print="hide"
          className="sticky top-[var(--docs-top)] hidden max-h-[calc(100dvh-var(--docs-top))] self-start overflow-y-auto overscroll-contain pt-2 pb-10 xl:block"
        >
          <DocsToc headings={toc} />
        </aside>
      ) : null}
    </div>
  );
}
