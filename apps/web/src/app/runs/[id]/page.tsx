import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { AutopilotView } from "@/components/run/autopilot-view";
import { RunView } from "@/components/run/run-view";
import { isShipAPrEnabled } from "@/flags";
import { apiDeps } from "@/server/deps";
import { reviveOrSweep } from "@/server/durable";
import { currentGuest } from "@/server/page-session";
import { getRunRecord } from "@/server/runs";
import { runTarget } from "@/lib/runs/target";

export const maxDuration = 300;

export const metadata: Metadata = { title: "Run" };

export default async function RunPage({ params }: PageProps<"/runs/[id]">) {
  const { id } = await params;
  const guest = await currentGuest();
  if (guest === null) notFound();
  const found = await getRunRecord(guest.app, guest.session.userId, id);
  if (found === null) notFound();
  const record = (await reviveOrSweep(guest.app, guest.session.userId, found, apiDeps())) ?? found;
  if (record.mission === "autopilot")
    return (
      <AutopilotView
        key={record.id}
        runId={record.id}
        simulated={record.execution === "simulated"}
      />
    );
  return (
    <RunView
      key={record.id}
      runId={record.id}
      target={runTarget(record.input)}
      simulated={record.execution === "simulated"}
      missionId={record.mission}
      shipEnabled={isShipAPrEnabled(process.env)}
    />
  );
}
