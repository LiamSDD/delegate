import type { Metadata } from "next";

import { ArrivalPage } from "@/components/arrival-page";
import { GitHubAppSetup, type GitHubAppStatus } from "@/components/github-app-setup";
import { isOwnerModeEnabled, isShipAPrEnabled } from "@/flags";

export const metadata: Metadata = { title: "Settings" };

export const dynamic = "force-dynamic";

function sandboxKind(env: NodeJS.ProcessEnv): GitHubAppStatus["sandbox"] {
  const requested = env.DELEGATE_SANDBOX?.trim().toLowerCase();
  if (requested === undefined || requested === "")
    return env.NODE_ENV === "production" ? "vercel" : "local";
  return requested === "local" || requested === "vercel" ? requested : "invalid";
}

export default function SettingsPage() {
  const env = process.env;
  const slug = env.GITHUB_APP_SLUG?.trim();
  const status: GitHubAppStatus = {
    configured:
      (env.GITHUB_APP_ID?.trim() ?? "") !== "" && (env.GITHUB_APP_PRIVATE_KEY?.trim() ?? "") !== "",
    slug: slug !== undefined && /^[a-z0-9-]{1,100}$/i.test(slug) ? slug : null,
    ownerMode: isOwnerModeEnabled(env),
    shipEnabled: isShipAPrEnabled(env),
    sandbox: sandboxKind(env),
  };
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
      <GitHubAppSetup status={status} />
    </ArrivalPage>
  );
}
