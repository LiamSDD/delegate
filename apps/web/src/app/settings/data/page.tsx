import type { Metadata } from "next";

import { DataView, parseExportOutcome } from "@/components/settings/data-view";
import { DELETE_CONFIRMATION } from "@/server/data/delete";
import { EXPORT_MAX_BYTES, EXPORT_MAX_DURATION_MS, EXPORTS_PER_HOUR } from "@/server/data/export";
import { dataInventory, EMPTY_INVENTORY } from "@/server/data/inventory";
import { currentGuest } from "@/server/page-session";

export const metadata: Metadata = { title: "Data" };

export const dynamic = "force-dynamic";

export default async function DataPage({ searchParams }: PageProps<"/settings/data">) {
  const guest = await currentGuest();
  const inventory =
    guest === null ? EMPTY_INVENTORY : await dataInventory(guest.app, guest.session);
  return (
    <DataView
      inventory={inventory}
      hasWorkspace={guest !== null}
      exportFacts={{
        maxBytes: EXPORT_MAX_BYTES,
        maxSeconds: EXPORT_MAX_DURATION_MS / 1000,
        perHour: EXPORTS_PER_HOUR,
      }}
      exportOutcome={parseExportOutcome((await searchParams).export)}
      deletePhrase={DELETE_CONFIRMATION}
    />
  );
}
