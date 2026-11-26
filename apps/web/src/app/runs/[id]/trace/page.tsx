import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { TraceView } from "@/components/trace/trace-view";
import { runTarget } from "@/lib/runs/target";
import { currentGuest } from "@/server/page-session";
import { getRunRecord } from "@/server/runs";

export const metadata: Metadata = { title: "Trace" };

export default async function TracePage({ params }: PageProps<"/runs/[id]/trace">) {
  const { id } = await params;
  const guest = await currentGuest();
  if (guest === null) notFound();
  const record = await getRunRecord(guest.app, guest.session.userId, id);
  if (record === null) notFound();
  return (
    <TraceView
      key={record.id}
      runId={record.id}
      target={runTarget(record.input)}
      missionId={record.mission}
    />
  );
}
