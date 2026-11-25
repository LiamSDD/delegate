import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";

import { ConnectionsPanel } from "@/components/settings/connections-panel";
import { connectionsOverview } from "@/server/connections-api";
import { connectionsDeps } from "@/server/deps";
import { currentGuest } from "@/server/page-session";

export const metadata: Metadata = { title: "Connections" };

const GITHUB_OUTCOMES: Record<string, { tone: "ok" | "warn"; text: string }> = {
  installed: { tone: "ok", text: "GitHub installation connected to this workspace." },
  authorized: {
    tone: "ok",
    text: "GitHub authorized. Now install the app on the repositories Delegate may open PRs on.",
  },
  not_configured: { tone: "warn", text: "The GitHub App is not configured on this deployment." },
  state_rejected: {
    tone: "warn",
    text: "The GitHub response did not match this browser session, so it was ignored. Start again from this page.",
  },
  denied: { tone: "warn", text: "GitHub authorization was cancelled." },
  exchange_failed: { tone: "warn", text: "GitHub did not accept the authorization. Try again." },
  not_your_installation: {
    tone: "warn",
    text: "That installation is not accessible to the GitHub account you authorized with, so it was not connected.",
  },
  missing_installation: { tone: "warn", text: "GitHub did not say which installation to connect." },
  github_unavailable: { tone: "warn", text: "GitHub could not be reached. Try again shortly." },
};

async function requestOrigin(): Promise<string> {
  const list = await headers();
  const host = list.get("x-forwarded-host") ?? list.get("host") ?? "localhost:3000";
  const proto = list.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto.split(",")[0]?.trim() ?? "https"}://${host.split(",")[0]?.trim() ?? host}`;
}

export default async function ConnectionsPage({
  searchParams,
}: PageProps<"/settings/connections">) {
  const guest = await currentGuest();
  const deps = connectionsDeps();
  const overview = await connectionsOverview(
    guest?.app ?? (await deps.api.app()),
    guest?.session ?? null,
    deps,
  );
  const outcomeKey = (await searchParams).github;
  const outcome = typeof outcomeKey === "string" ? GITHUB_OUTCOMES[outcomeKey] : undefined;
  return (
    <div className="mx-auto flex max-w-content flex-col gap-10 px-4 pt-16 pb-24 sm:px-6 md:pt-24">
      <header className="flex flex-col gap-4">
        <p className="font-mono text-2xs tracking-label text-text-subtle uppercase">
          <Link href="/settings" className="hover:text-text">
            Settings
          </Link>{" "}
          <span aria-hidden="true">/</span> Connections
        </p>
        <h1 className="font-serif text-display-md tracking-display text-balance">
          Connect Delegate to your tools, and your tools to Delegate
        </h1>
        <p className="max-w-2xl text-md text-text-muted text-pretty">
          Call Delegate from Claude Code, Codex or any MCP client; give it your own MCP servers and
          GitHub repositories. Every call goes through the same policies, approvals and audit log as
          the web app.
        </p>
      </header>
      {outcome === undefined ? null : (
        <p
          role="status"
          className={`rounded-lg border px-4 py-3 text-sm ${
            outcome.tone === "ok"
              ? "border-success/40 bg-success-soft text-success"
              : "border-warning/40 bg-warning-soft text-warning"
          }`}
        >
          {outcome.text}
        </p>
      )}
      <ConnectionsPanel initial={overview} origin={await requestOrigin()} />
    </div>
  );
}
