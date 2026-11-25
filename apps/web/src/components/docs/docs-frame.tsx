"use client";

import { Menu, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";

import type { NavSection } from "@/lib/docs/registry";

import { DocsNav, findNavItem } from "./docs-nav";
import { DocsSearchButton, DocsSearchProvider } from "./docs-search";

const SITE_HEADER_SELECTOR = "body > header";

function useHeaderOffset() {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = rootRef.current;
    const header = document.querySelector<HTMLElement>(SITE_HEADER_SELECTOR);
    if (root === null || header === null) return;
    const apply = () => {
      root.style.setProperty(
        "--docs-top",
        `${Math.round(header.getBoundingClientRect().height)}px`,
      );
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(header);
    return () => {
      observer.disconnect();
    };
  }, []);
  return rootRef;
}

function Drawer({ sections, onClose }: { sections: readonly NavSection[]; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    return () => {
      dialog.close();
      previouslyFocused?.focus();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      aria-label="Documentation menu"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="fixed inset-y-0 left-0 m-0 h-dvh max-h-none w-[min(21rem,calc(100vw-3rem))] max-w-none overflow-y-auto overscroll-contain border-r border-border bg-bg p-0 text-text shadow-lg backdrop:bg-overlay"
    >
      <div className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-border bg-bg px-5">
        <p className="font-serif text-xl leading-none tracking-display">Docs</p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close the documentation menu"
          className="inline-flex size-8 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-2 hover:text-text"
        >
          <X className="size-4" strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>
      <div className="px-5 pt-5 pb-10">
        <DocsNav sections={sections} onNavigate={onClose} label="Documentation, menu" />
      </div>
    </dialog>
  );
}

function MobileBar({ sections }: { sections: readonly NavSection[] }) {
  const pathname = usePathname();
  const [drawer, setDrawer] = useState<{ at: string } | null>(null);
  const open = drawer !== null && drawer.at === pathname;
  const current = findNavItem(sections, pathname);
  return (
    <div
      data-print="hide"
      className="sticky top-[var(--docs-top)] z-30 -mx-4 flex h-11 items-center gap-1 border-b border-border bg-bg/90 px-2 backdrop-blur-md sm:-mx-6 sm:px-4 lg:hidden"
    >
      <button
        type="button"
        onClick={() => {
          setDrawer({ at: pathname });
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="inline-flex h-8 shrink-0 items-center gap-2 rounded-md px-2 text-sm text-text transition-colors hover:bg-surface-2"
      >
        <Menu className="size-4" strokeWidth={1.5} aria-hidden="true" />
        Menu
      </button>
      <p className="min-w-0 flex-1 truncate px-1 text-sm text-text-muted">
        {current === null ? (
          "Docs"
        ) : (
          <>
            <span className="text-text-subtle">{current.section.title}</span>
            <span aria-hidden="true" className="px-1.5 text-text-subtle">
              /
            </span>
            <span className="text-text">
              {current.parent === null ? current.item.label : `ADR ${current.item.prefix ?? ""}`}
            </span>
          </>
        )}
      </p>
      <DocsSearchButton compact />
      {open ? (
        <Drawer
          sections={sections}
          onClose={() => {
            setDrawer(null);
          }}
        />
      ) : null}
    </div>
  );
}

export function DocsFrame({
  sections,
  children,
}: {
  sections: readonly NavSection[];
  children: ReactNode;
}) {
  const rootRef = useHeaderOffset();
  return (
    <DocsSearchProvider>
      <div
        ref={rootRef}
        className="mx-auto w-full max-w-content px-4 [--docs-top:6.375rem] sm:px-6 md:[--docs-top:3.5625rem]"
      >
        <MobileBar sections={sections} />
        <div className="lg:grid lg:grid-cols-[15.5rem_minmax(0,1fr)] lg:gap-12">
          <aside
            data-print="hide"
            className="sticky top-[var(--docs-top)] hidden h-[calc(100dvh-var(--docs-top))] flex-col gap-6 overflow-y-auto overscroll-contain py-8 pr-2 lg:flex"
          >
            <DocsSearchButton />
            <DocsNav sections={sections} />
          </aside>
          <div className="min-w-0 pt-8 pb-24 lg:pt-10">{children}</div>
        </div>
      </div>
    </DocsSearchProvider>
  );
}
