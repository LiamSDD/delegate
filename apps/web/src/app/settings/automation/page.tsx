import type { Metadata } from "next";

import { AutomationView, NO_AUTOMATION } from "@/components/settings/automation-view";
import { currentGuest } from "@/server/page-session";
import { readAutomation } from "@/server/workspace-settings";

export const metadata: Metadata = { title: "Automation" };

export const dynamic = "force-dynamic";

export default async function AutomationPage() {
  const guest = await currentGuest();
  const automation =
    guest === null ? NO_AUTOMATION : await readAutomation(guest.app, guest.session);
  return <AutomationView automation={automation} />;
}
