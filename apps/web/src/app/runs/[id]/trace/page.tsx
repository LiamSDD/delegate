import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { TraceView } from "@/components/trace/trace-view";
import { currentGuest } from "@/server/page-session";
import { getRunRecord } from "@/server/runs";

export const metadata: Metadata = { title: "Trace" };

export default async function TracePage({ params }: PageProps<"/runs/[id]/trace">) {
  const { id } = await params;
  const guest = await currentGuest();
  if (guest === null) notFound();
  const record = await getRunRecord(guest.app, guest.session.userId, id);
  if (record === null) notFound();
  const url = typeof record.input.url === "string" ? record.input.url : null;
  return (
    <TraceView
      key={record.id}
      runId={record.id}
      target={url === null ? null : new URL(url).hostname.replace(/^www\./, "")}
      missionId={record.mission}
    />
  );
}
