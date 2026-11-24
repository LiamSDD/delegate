import type { Metadata } from "next";

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
    />
  );
}
