import Link from "next/link";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export const SETTINGS_PAGES = [
  {
    href: "/settings",
    label: "Overview",
    summary: "The workspace this browser works in, how long its data is kept, and the theme.",
  },
  {
    href: "/settings/connections",
    label: "Connections",
    summary: "API tokens for Claude Code and Codex, your MCP servers and GitHub repositories.",
  },
  {
    href: "/settings/webhooks",
    label: "Webhooks",
    summary: "Outgoing webhooks for this workspace.",
  },
  {
    href: "/settings/policies",
    label: "Policies",
    summary: "The rules every tool call is checked against, and a dry run to test a call.",
  },
  {
    href: "/settings/data",
    label: "Data",
    summary: "Export everything this workspace holds, or delete it for good.",
  },
  {
    href: "/settings/automation",
    label: "Automation",
    summary: "What may be approved without asking: mission plans and chosen connector tools.",
  },
] as const;

export type SettingsHref = (typeof SETTINGS_PAGES)[number]["href"];

export function SettingsFrame({
  current,
  title,
  summary,
  busy = false,
  children,
}: {
  current: SettingsHref;
  title: string;
  summary: string;
  busy?: boolean;
  children: ReactNode;
}) {
  const page = SETTINGS_PAGES.find((entry) => entry.href === current);
  return (
    <div
      aria-busy={busy ? "true" : undefined}
      className="mx-auto flex max-w-content min-w-0 flex-col gap-10 px-4 pt-16 pb-24 sm:px-6 md:pt-24"
    >
      <header className="flex flex-col gap-4">
        <p className="font-mono text-2xs tracking-label text-text-subtle uppercase">
          {current === "/settings" ? (
            "Settings"
          ) : (
            <>
              <Link href="/settings" className="hover:text-text">
                Settings
              </Link>{" "}
              <span aria-hidden="true">/</span> {page?.label}
            </>
          )}
        </p>
        <h1 className="font-serif text-display-sm tracking-display text-balance sm:text-display-md">
          {title}
        </h1>
        <p className="max-w-2xl text-md text-text-muted text-pretty">{summary}</p>
        <nav aria-label="Settings sections" className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <ul className="flex w-max gap-2 sm:w-auto sm:flex-wrap">
            {SETTINGS_PAGES.map((entry) => (
              <li key={entry.href}>
                <Link
                  href={entry.href}
                  aria-current={entry.href === current ? "page" : undefined}
                  className={cn(
                    "inline-flex h-8 items-center rounded-md border px-3 text-sm whitespace-nowrap",
                    entry.href === current
                      ? "border-border-strong bg-surface text-text shadow-sm"
                      : "border-border text-text-muted hover:border-border-strong hover:text-text",
                  )}
                >
                  {entry.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      {children}
    </div>
  );
}

export function SettingsSection({
  id,
  title,
  lede,
  children,
}: {
  id: string;
  title: string;
  lede?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="flex min-w-0 scroll-mt-28 flex-col gap-5 border-t border-border pt-8"
    >
      <div className="flex max-w-2xl flex-col gap-2">
        <h2 id={id} className="text-lg font-medium text-text">
          {title}
        </h2>
        {lede === undefined ? null : <p className="text-sm text-text-muted text-pretty">{lede}</p>}
      </div>
      {children}
    </section>
  );
}

export function SettingsLoading({
  current,
  title,
  summary,
  reading,
  sections,
}: {
  current: SettingsHref;
  title: string;
  summary: string;
  reading: string;
  sections: readonly string[];
}) {
  return (
    <SettingsFrame current={current} title={title} summary={summary} busy>
      <p role="status" className="font-mono text-2xs text-text-subtle">
        {reading}
      </p>
      {sections.map((section) => (
        <section key={section} className="flex flex-col gap-5 border-t border-border pt-8">
          <h2 className="text-lg font-medium text-text">{section}</h2>
          <div
            aria-hidden="true"
            className="flex flex-col gap-2 rounded-xl border border-border bg-surface px-4 py-4 motion-safe:animate-pulse"
          >
            <span className="h-4 w-32 rounded-sm bg-surface-2" />
            <span className="h-4 w-2/3 rounded-sm bg-surface-2" />
          </div>
        </section>
      ))}
    </SettingsFrame>
  );
}
