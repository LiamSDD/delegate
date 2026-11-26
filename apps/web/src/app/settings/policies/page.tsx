import type { Metadata } from "next";

import { PoliciesView } from "@/components/settings/policies-view";
import { policyFacts } from "@/server/control/policies";
import { getAppDatabase } from "@/server/db";
import { currentGuest } from "@/server/page-session";

export const metadata: Metadata = { title: "Policies" };

export const dynamic = "force-dynamic";

export default async function PoliciesPage() {
  const guest = await currentGuest();
  const facts = await policyFacts(
    guest?.app ?? (await getAppDatabase()),
    guest?.session ?? null,
    process.env,
  );
  return <PoliciesView facts={facts} />;
}
