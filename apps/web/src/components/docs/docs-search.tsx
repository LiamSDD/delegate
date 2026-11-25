"use client";

import { CornerDownLeft, FileText, Hash, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  createContext,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { z } from "zod";

import { Kbd } from "@/components/kbd";
import { SEARCH_INDEX_PATH, type SearchEntry, searchDocs } from "@/lib/docs/search";
import { cn } from "@/lib/utils";

const SearchIndexSchema = z.array(
  z.object({
    route: z.string().startsWith("/docs"),
    title: z.string(),
    section: z.string(),
    summary: z.string(),
    headings: z.array(z.object({ id: z.string(), text: z.string() })),
  }),
);

type IndexState =
  { status: "loading" } | { status: "ready"; entries: SearchEntry[] } | { status: "failed" };

let indexRequest: Promise<SearchEntry[]> | null = null;

function loadIndex(): Promise<SearchEntry[]> {
  indexRequest ??= fetch(SEARCH_INDEX_PATH, { headers: { accept: "application/json" } })
    .then(async (response) => {
      if (!response.ok) throw new Error(`Search index answered ${response.status}`);
      return SearchIndexSchema.parse(await response.json());
    })
    .catch((error: unknown) => {
      indexRequest = null;
      throw error;
    });
  return indexRequest;
}

interface SearchContextValue {
  open: () => void;
}

const SearchContext = createContext<SearchContextValue | null>(null);

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

export function DocsSearchProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback(() => {
    setIsOpen(true);
  }, []);
  const close = useCallback(() => {
    setIsOpen(false);
  }, []);
  const value = useMemo(() => ({ open }), [open]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditable(event.target) || document.querySelector("dialog[open]") !== null) return;
      event.preventDefault();
      setIsOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return (
    <SearchContext.Provider value={value}>
      {children}
      {isOpen ? <SearchDialog onClose={close} /> : null}
    </SearchContext.Provider>
  );
}

export function DocsSearchButton({ compact = false }: { compact?: boolean }) {
  const context = useContext(SearchContext);
  if (context === null) throw new Error("DocsSearchButton must be used inside DocsSearchProvider");
  if (compact)
    return (
      <button
        type="button"
        onClick={context.open}
        aria-label="Search the docs"
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-2 hover:text-text"
      >
        <Search className="size-4" strokeWidth={1.5} aria-hidden="true" />
      </button>
    );
  return (
    <button
      type="button"
      onClick={context.open}
      aria-keyshortcuts="/"
      className="flex h-9 w-full items-center gap-2.5 rounded-md border border-border bg-surface pr-2 pl-3 text-sm text-text-muted shadow-sm transition-colors hover:border-border-strong hover:text-text"
    >
      <Search className="size-3.5 shrink-0" strokeWidth={1.5} aria-hidden="true" />
      <span className="flex-1 text-left">Search the docs</span>
      <span aria-hidden="true" className="inline-flex">
        <Kbd>/</Kbd>
      </span>
    </button>
  );
}

function SearchDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [index, setIndex] = useState<IndexState>({ status: "loading" });
  const router = useRouter();
  const listId = useId();
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    inputRef.current?.focus();
    return () => {
      dialog.close();
      previouslyFocused?.focus();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadIndex().then(
      (entries) => {
        if (!cancelled) setIndex({ status: "ready", entries });
      },
      () => {
        if (!cancelled) setIndex({ status: "failed" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const hits = useMemo(
    () => (index.status === "ready" ? searchDocs(index.entries, query) : []),
    [index, query],
  );
  const activeIndex = Math.min(active, Math.max(hits.length - 1, 0));
  const activeHit = hits[activeIndex];
  const optionId = (position: number) => `${listId}-${position}`;

  const go = (href: string) => {
    onClose();
    router.push(href);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActive(hits.length === 0 ? 0 : (activeIndex + 1) % hits.length);
        return;
      case "ArrowUp":
        event.preventDefault();
        setActive(hits.length === 0 ? 0 : (activeIndex - 1 + hits.length) % hits.length);
        return;
      case "Home":
        event.preventDefault();
        setActive(0);
        return;
      case "End":
        event.preventDefault();
        setActive(Math.max(hits.length - 1, 0));
        return;
      case "Enter":
        event.preventDefault();
        if (activeHit !== undefined) go(activeHit.href);
        return;
    }
  };

  const trimmed = query.trim();
  let status: ReactNode = null;
  if (index.status === "failed")
    status = "The search index could not be loaded. Use the sidebar to browse the docs.";
  else if (index.status === "loading" && trimmed !== "") status = "Loading the index…";
  else if (trimmed === "") status = "Search page titles and section headings.";
  else if (hits.length === 0)
    status = (
      <>
        Nothing matches <span className="font-mono text-text">{trimmed}</span>
      </>
    );

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="fixed inset-x-0 top-[10vh] bottom-auto m-0 mx-auto h-fit w-[min(38rem,calc(100vw-2rem))] max-w-none overflow-hidden rounded-xl border border-border bg-surface p-0 text-text shadow-lg backdrop:bg-overlay"
    >
      <h2 id={titleId} className="sr-only">
        Search the docs
      </h2>
      <div className="flex h-12 items-center gap-3 border-b border-border px-4">
        <Search className="size-4 shrink-0 text-text-subtle" strokeWidth={1.5} aria-hidden="true" />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded={hits.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeHit === undefined ? undefined : optionId(activeIndex)}
          aria-label="Search the docs"
          placeholder="Search titles and headings"
          autoComplete="off"
          spellCheck={false}
          maxLength={120}
          className="h-full min-w-0 flex-1 bg-transparent text-base text-text outline-none placeholder:text-text-subtle focus-visible:outline-none"
        />
        <Kbd>esc</Kbd>
      </div>
      <ul
        id={listId}
        role="listbox"
        aria-label="Results"
        className="max-h-[min(24rem,60vh)] overflow-y-auto p-2 empty:hidden"
      >
        {hits.map((hit, position) => {
          const selected = position === activeIndex;
          const Icon = hit.heading === null ? FileText : Hash;
          return (
            <li
              key={hit.href}
              id={optionId(position)}
              role="option"
              aria-selected={selected}
              onMouseMove={() => {
                if (!selected) setActive(position);
              }}
              onClick={() => {
                go(hit.href);
              }}
              className={cn(
                "flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm text-text-muted",
                selected && "bg-surface-2 text-text",
              )}
            >
              <Icon
                className="size-4 shrink-0 text-text-subtle"
                strokeWidth={1.5}
                aria-hidden="true"
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-text">{hit.heading ?? hit.title}</span>
                <span className="truncate font-mono text-2xs text-text-subtle">
                  {hit.heading === null ? hit.section : `${hit.section} / ${hit.title}`}
                </span>
              </span>
              {selected ? (
                <CornerDownLeft
                  className="size-3.5 shrink-0 text-text-subtle"
                  strokeWidth={1.5}
                  aria-hidden="true"
                />
              ) : null}
            </li>
          );
        })}
      </ul>
      {status === null ? null : (
        <p role="status" className="px-5 py-6 text-center text-sm text-text-muted">
          {status}
        </p>
      )}
      <div className="flex h-9 items-center gap-4 border-t border-border bg-surface-2 px-4 text-xs text-text-subtle">
        <span className="flex items-center gap-1.5">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
          navigate
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>↵</Kbd>
          open
        </span>
      </div>
    </dialog>
  );
}
