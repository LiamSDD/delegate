import type { Metadata } from "next";

import { GitHubAppSetup, type GitHubAppStatus } from "@/components/github-app-setup";
import { SettingsOverview } from "@/components/settings/overview";
import { isOwnerModeEnabled, isShipAPrEnabled } from "@/flags";
import { workspaceOverview } from "@/server/control/workspace";
import { currentGuest } from "@/server/page-session";

export const metadata: Metadata = { title: "Settings" };

export const dynamic = "force-dynamic";

function sandboxKind(env: NodeJS.ProcessEnv): GitHubAppStatus["sandbox"] {
  const requested = env.DELEGATE_SANDBOX?.trim().toLowerCase();
  if (requested === undefined || requested === "")
    return env.NODE_ENV === "production" ? "vercel" : "local";
  return requested === "local" || requested === "vercel" ? requested : "invalid";
}

export default async function SettingsPage() {
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
  const guest = await currentGuest();
  const workspace = guest === null ? null : await workspaceOverview(guest.app, guest.session);
  return <SettingsOverview workspace={workspace} deployment={<GitHubAppSetup status={status} />} />;
}
