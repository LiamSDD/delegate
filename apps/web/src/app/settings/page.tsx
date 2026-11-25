import type { Metadata } from "next";
import Link from "next/link";

import { ArrivalPage } from "@/components/arrival-page";

export const metadata: Metadata = { title: "Settings" };

export default function SettingsPage() {
  return (
    <ArrivalPage
      section="Settings"
      milestone="M7"
      title="Who can do what, and with which data"
      summary="Workspace governance: roles, policies, connectors and where your data goes."
      willShow={[
        "Members and roles: owner, admin, operator, viewer",
        "The policy editor, with a dry-run against past runs",
        "MCP connectors and API keys",
        "Model providers, including bring-your-own Claude key",
        "Data retention and the audit log viewer",
      ]}
    >
      <p className="border-l-2 border-border-strong pl-4 text-sm text-text-muted">
        Available now:{" "}
        <Link
          href="/settings/connections"
          className="text-text underline underline-offset-4 hover:text-accent"
        >
          connections
        </Link>
        : API tokens for Claude Code and Codex, your MCP servers, GitHub and automation defaults.
      </p>
    </ArrivalPage>
  );
}
