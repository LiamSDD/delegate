import type { Metadata } from "next";

import { MissionControlView } from "@/components/control/mission-control";
import { emptyMissionControl, missionControl } from "@/server/control/overview";
import { currentGuest } from "@/server/page-session";

export const metadata: Metadata = { title: "Mission Control" };

export const dynamic = "force-dynamic";

export default async function ControlPage() {
  const guest = await currentGuest();
  const control =
    guest === null ? emptyMissionControl() : await missionControl(guest.app, guest.session);
  return <MissionControlView control={control} />;
}
