import { ArrowRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { Chip } from "@/components/run/primitives";
import type { WorkspaceOverview } from "@/server/control/workspace";

import { SETTINGS_PAGES, SettingsFrame, SettingsSection } from "./settings-frame";
import { ThemeChoice } from "./theme-choice";

export const OVERVIEW_TITLE = "Your workspace, its rules and its data";
export const OVERVIEW_SUMMARY =
  "What this browser's workspace is, how long Delegate keeps what it produces, and where to change how it connects, what it may do and what happens to its data.";

const createdFormat = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 border-b border-border px-4 py-3 last:border-b-0 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-6">
      <dt className="font-mono text-2xs tracking-label text-text-subtle uppercase sm:pt-0.5">
        {label}
      </dt>
      <dd className="min-w-0 text-sm text-text">{children}</dd>
    </div>
  );
}

function retention(workspace: WorkspaceOverview): string {
  if (workspace.retentionDays === null)
    return "No automatic deletion: runs are kept until you delete them.";
  const days = `${String(workspace.retentionDays)} ${workspace.retentionDays === 1 ? "day" : "days"}`;
  if (!workspace.demo)
    return `${days} is recorded, but automatic deletion only applies to demo workspaces: runs are kept until you delete them.`;
  return `${days}. A run, with its events, artifacts and audit entries, is removed once it is older than ${days}.`;
}

function WorkspaceFacts({ workspace }: { workspace: WorkspaceOverview | null }) {
  if (workspace === null)
    return (
      <div
        data-empty-state=""
        className="flex flex-col gap-1.5 rounded-xl border border-dashed border-border-strong px-5 py-6"
      >
        <p className="text-sm font-medium text-text">No workspace yet</p>
        <p className="max-w-2xl text-sm text-text-muted text-pretty">
          Delegate creates an anonymous guest workspace with your first run, tied to a cookie in
          this browser. Its id, kind, creation date and retention period will be listed here.{" "}
          <Link href="/?focus=mission" className="text-text underline underline-offset-4">
            Start a run
          </Link>
        </p>
      </div>
    );
  const connected = workspace.tier === "connected";
  return (
    <dl className="flex flex-col rounded-xl border border-border bg-surface shadow-sm">
      <Row label="Workspace id">
        <span className="font-mono break-all">{workspace.id}</span>
      </Row>
      <Row label="Kind">
        <span className="flex flex-wrap items-center gap-2">
          <Chip tone={connected ? "accent" : "neutral"}>{connected ? "Connected" : "Guest"}</Chip>
          <span className="text-text-muted">
            {connected
              ? `Anonymous, with ${String(workspace.connectors)} MCP ${workspace.connectors === 1 ? "connector" : "connectors"} and ${String(workspace.githubInstallations)} GitHub ${workspace.githubInstallations === 1 ? "installation" : "installations"} linked.`
              : "Anonymous, identified by a cookie in this browser. Nothing is linked yet; it becomes connected when you add an MCP server or GitHub."}
          </span>
        </span>
      </Row>
      <Row label="Created">
        <time dateTime={workspace.createdAt.toISOString()} className="font-mono tabular">
          {createdFormat.format(workspace.createdAt)} UTC
        </time>
      </Row>
      <Row label="Retention">{retention(workspace)}</Row>
      <Row label="Your role">
        <span className="font-mono">{workspace.role ?? "none"}</span>
      </Row>
    </dl>
  );
}

export function SettingsOverview({
  workspace,
  deployment,
}: {
  workspace: WorkspaceOverview | null;
  deployment?: ReactNode;
}) {
  return (
    <SettingsFrame current="/settings" title={OVERVIEW_TITLE} summary={OVERVIEW_SUMMARY}>
      <SettingsSection id="workspace" title="Workspace">
        <WorkspaceFacts workspace={workspace} />
      </SettingsSection>

      <SettingsSection id="sections" title="Settings pages">
        <ul className="flex flex-col rounded-xl border border-border bg-surface shadow-sm">
          {SETTINGS_PAGES.filter((page) => page.href !== "/settings").map((page) => (
            <li key={page.href} className="border-b border-border last:border-b-0">
              <Link
                href={page.href}
                className="group flex items-center justify-between gap-4 px-4 py-3.5 hover:bg-surface-2/60"
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-base font-medium text-text">{page.label}</span>
                  <span className="text-sm text-text-muted text-pretty">{page.summary}</span>
                </span>
                <ArrowRight
                  className="size-4 shrink-0 text-text-subtle group-hover:text-accent"
                  aria-hidden="true"
                />
              </Link>
            </li>
          ))}
        </ul>
      </SettingsSection>

      <SettingsSection id="theme" title="Theme">
        <ThemeChoice />
      </SettingsSection>

      {deployment === undefined ? null : (
        <div className="flex min-w-0 flex-col border-t border-border pt-8">{deployment}</div>
      )}
    </SettingsFrame>
  );
}
