import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { RunView } from "@/components/run/run-view";
import { currentGuest } from "@/server/page-session";
import { getRunRecord, sweepIfStale } from "@/server/runs";

export const metadata: Metadata = { title: "Run" };

export default async function RunPage({ params }: PageProps<"/runs/[id]">) {
  const { id } = await params;
  const guest = await currentGuest();
  if (guest === null) notFound();
  const record = await getRunRecord(guest.app, guest.session.userId, id);
  if (record === null) notFound();
  await sweepIfStale(guest.app, guest.session.userId, record);
  const url = typeof record.input.url === "string" ? record.input.url : null;
  return (
    <RunView
      key={record.id}
      runId={record.id}
      target={url === null ? null : new URL(url).hostname.replace(/^www\./, "")}
      simulated={record.execution === "simulated"}
    />
  );
}
