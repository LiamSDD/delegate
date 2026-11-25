import type { Metadata } from "next";
import { z } from "zod";

import { CompareMessage, CompareView } from "@/components/run/compare-view";
import { compareRuns } from "@/lib/runs/compare";
import { currentGuest } from "@/server/page-session";
import { getRunRecord, readAllEvents } from "@/server/runs";

export const metadata: Metadata = { title: "Compare runs" };

const ParamsSchema = z.object({ a: z.uuid(), b: z.uuid() });

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function Unavailable() {
  return (
    <CompareMessage eyebrow="Run compare · 404" title="These runs are not available">
      One of them does not exist, belongs to another session, or was deleted: demo runs are deleted
      after 7 days.
    </CompareMessage>
  );
}

export default async function ComparePage({ searchParams }: PageProps<"/runs/compare">) {
  const raw = await searchParams;
  const parsed = ParamsSchema.safeParse({ a: first(raw.a), b: first(raw.b) });
  if (!parsed.success)
    return (
      <CompareMessage eyebrow="Run compare" title="Pick two runs to compare">
        Open a forked run and choose “Compare with parent”, or pass two run ids as{" "}
        <code className="font-mono text-sm">/runs/compare?a=…&amp;b=…</code>.
      </CompareMessage>
    );
  const guest = await currentGuest();
  const [a, b] =
    guest === null
      ? [null, null]
      : await Promise.all([
          getRunRecord(guest.app, guest.session.userId, parsed.data.a),
          getRunRecord(guest.app, guest.session.userId, parsed.data.b),
        ]);
  if (guest === null || a === null || b === null) return <Unavailable />;
  const [eventsA, eventsB] = await Promise.all([
    readAllEvents(guest.app, guest.session.userId, a.id),
    readAllEvents(guest.app, guest.session.userId, b.id),
  ]);
  const comparison = compareRuns(
    { runId: a.id, events: eventsA },
    { runId: b.id, events: eventsB },
  );
  if (!comparison.ok)
    return (
      <CompareMessage eyebrow="Run compare · error" title="An event log could not be rebuilt">
        <span className="font-mono text-sm">{comparison.error}</span>
      </CompareMessage>
    );
  return (
    <CompareView
      a={comparison.a}
      b={comparison.b}
      claims={comparison.claims}
      sameMission={comparison.sameMission}
    />
  );
}
