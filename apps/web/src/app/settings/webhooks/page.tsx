import type { Metadata } from "next";
import Link from "next/link";

import { WebhooksPanel } from "@/components/settings/webhooks/webhooks-panel";
import { getAppDatabase } from "@/server/db";
import { currentGuest } from "@/server/page-session";
import { flushSoon } from "@/server/webhooks/dispatch";
import { webhooksOverview } from "@/server/webhooks/settings-api";

export const metadata: Metadata = { title: "Webhooks" };

export const dynamic = "force-dynamic";

export default async function WebhooksPage() {
  const guest = await currentGuest();
  if (guest !== null) flushSoon(guest.app, guest.session);
  const overview = await webhooksOverview(
    guest?.app ?? (await getAppDatabase()),
    guest?.session ?? null,
  );
  return (
    <div className="mx-auto flex max-w-content flex-col gap-10 px-4 pt-16 pb-24 sm:px-6 md:pt-24">
      <header className="flex flex-col gap-4">
        <p className="font-mono text-2xs tracking-label text-text-subtle uppercase">
          <Link href="/settings" className="hover:text-text">
            Settings
          </Link>{" "}
          <span aria-hidden="true">/</span> Webhooks
        </p>
        <h1 className="font-serif text-display-md tracking-display text-balance">
          Be told when a run finishes or needs you
        </h1>
        <p className="max-w-2xl text-md text-text-muted text-pretty">
          Register an HTTPS endpoint and Delegate posts a signed event to it instead of making you
          poll. API tokens for the REST API, the SDK and the{" "}
          <code className="font-mono text-sm">delegate</code> CLI are on{" "}
          <Link
            href="/settings/connections"
            className="text-text underline underline-offset-4 hover:text-accent"
          >
            Connections
          </Link>
          .
        </p>
      </header>
      <WebhooksPanel initial={overview} />
    </div>
  );
}
