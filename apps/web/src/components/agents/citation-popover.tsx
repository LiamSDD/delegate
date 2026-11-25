"use client";

import { ArrowUpRight } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import type { IndexedCitation } from "@/lib/agents/chat";
import { hostOf } from "@/lib/runs/build-agent";
import { cn } from "@/lib/utils";

export function CitationPopover({ citation }: { citation: IndexedCitation }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const wrapper = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (wrapper.current !== null && !wrapper.current.contains(event.target as Node))
        setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  return (
    <span
      ref={wrapper}
      className="relative inline-block"
      onMouseEnter={() => {
        setOpen(true);
      }}
      onMouseLeave={() => {
        setOpen(false);
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        aria-label={`Source ${String(citation.index)}: ${citation.title ?? hostOf(citation.url)}`}
        onClick={() => {
          setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
        onFocus={() => {
          setOpen(true);
        }}
        onBlur={(event) => {
          if (!wrapper.current?.contains(event.relatedTarget)) setOpen(false);
        }}
        className={cn(
          "mx-0.5 inline-flex h-4 min-w-4 -translate-y-1 items-center justify-center rounded-sm px-1 align-baseline font-mono text-[10px] leading-none font-medium tabular transition-colors",
          open
            ? "bg-accent text-accent-fg"
            : "bg-accent-soft text-accent hover:bg-accent hover:text-accent-fg",
        )}
      >
        {citation.index}
      </button>
      <span
        id={id}
        role="note"
        hidden={!open}
        className="absolute bottom-full left-1/2 z-30 mb-1.5 w-72 max-w-[80vw] -translate-x-1/2 rounded-lg border border-border bg-surface p-3 text-left shadow-lg"
      >
        <span className="block text-xs font-medium text-text">
          {citation.title ?? hostOf(citation.url)}
        </span>
        <a
          href={citation.url}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="mt-0.5 flex items-center gap-1 truncate font-mono text-2xs text-text-muted hover:text-accent"
        >
          <span className="truncate">{citation.url.replace(/^https?:\/\//, "")}</span>
          <ArrowUpRight className="size-3 shrink-0" aria-hidden="true" />
        </a>
        {citation.quote === undefined || citation.quote === "" ? null : (
          <span className="mt-2 block border-l-2 border-accent/50 pl-2 text-xs leading-5 text-text-muted">
            “{citation.quote}”
          </span>
        )}
      </span>
    </span>
  );
}
