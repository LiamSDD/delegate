import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { KindGlyph } from "@/components/kind-glyph";
import { MilestoneBadge } from "@/components/milestone-badge";
import { RoadmapRail } from "@/components/roadmap-rail";
import { RunAgainButton } from "@/components/run/run-status";
import { draftFromQuery } from "@/lib/mission-draft";

export const metadata: Metadata = { title: "New run" };

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 border-t border-border py-3.5 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-6">
      <dt className="font-mono text-2xs leading-6 tracking-label text-text-subtle uppercase">
        {term}
      </dt>
      <dd className="min-w-0 text-sm text-text">{children}</dd>
    </div>
  );
}

export default async function NewRunPage({ searchParams }: PageProps<"/runs/new">) {
  const { q } = await searchParams;
  const draft = draftFromQuery(q);

  if (draft === null) {
    return (
      <div className="mx-auto flex max-w-content flex-col gap-5 px-6 pt-16 pb-24 md:pt-24">
        <p className="font-mono text-2xs tracking-label text-text-subtle uppercase">New run</p>
        <h1 className="font-serif text-display-md tracking-display">Nothing to draft yet</h1>
        <p className="max-w-xl text-md text-text-muted">
          Start from the home page with a company URL, a GitHub repo or a goal.
        </p>
        <Link
          href="/?focus=mission"
          className="inline-flex h-9 w-fit items-center rounded-md bg-accent px-4 text-sm font-medium text-accent-fg hover:bg-accent/90"
        >
          New run
        </Link>
      </div>
    );
  }

  const { detected } = draft;
  const live = detected.kind === "company";
  const spec = {
    kind: detected.kind,
    missions: detected.missionIds,
    target: detected.target,
    ...(detected.kind === "goal" ? {} : { url: detected.url }),
    status: live ? "ready" : "not-started",
  };

  return (
    <div className="mx-auto grid max-w-content gap-16 px-6 pt-16 pb-24 md:pt-24 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-24">
      <div className="flex flex-col gap-12">
        <header className="flex flex-col gap-5">
          <p className="font-mono text-2xs tracking-label text-text-subtle uppercase">
            New run <span aria-hidden="true">·</span> {live ? "ready" : "draft"}
          </p>
          {live ? (
            <>
              <h1 className="font-serif text-display-md tracking-display text-balance">
                Analyse {detected.target}
              </h1>
              <p className="max-w-xl text-md text-text-muted text-pretty">
                Nothing has started yet. Pick a mission: the AI Automation Audit ranks workflows to
                automate with an adjustable ROI model; the Company X-ray writes a cited brief.
              </p>
              <div className="flex flex-wrap gap-3">
                <RunAgainButton
                  input={{ missionId: "automation-audit", input: { url: detected.url } }}
                  label="Start Automation Audit"
                />
                <RunAgainButton
                  input={{ missionId: "company-xray", input: { url: detected.url } }}
                  label="Start Company X-ray"
                />
              </div>
            </>
          ) : (
            <>
              <h1 className="font-serif text-display-md tracking-display text-balance">
                Runs arrive in {draft.firstArrival}
              </h1>
              <p className="max-w-xl text-md text-text-muted text-pretty">
                Nothing was started and no model was called. This is the mission Delegate read from
                your input; the runtime that plans and executes it lands in {draft.firstArrival}.
              </p>
            </>
          )}
        </header>

        <section aria-labelledby="parsed" className="flex flex-col gap-4">
          <h2 id="parsed" className="font-mono text-2xs tracking-label text-text-subtle uppercase">
            Parsed mission
          </h2>
          <dl className="border-b border-border">
            <Row term="Input">
              <span className="font-mono text-xs break-words text-text-muted">{draft.input}</span>
              {draft.truncated ? (
                <span className="ml-2 font-mono text-2xs text-text-subtle">(truncated)</span>
              ) : null}
            </Row>
            <Row term="Detected">
              <span className="inline-flex h-6 items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 text-xs font-medium">
                <KindGlyph kind={detected.kind} />
                {detected.label}
              </span>
            </Row>
            <Row term="Target">
              <span className="font-mono text-xs break-words">{detected.target}</span>
            </Row>
            <Row term="Missions">
              <ol className="flex flex-col gap-2">
                {draft.missions.map((mission, index) => (
                  <li key={mission.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="font-mono text-xs text-text-subtle tabular">{index + 1}</span>
                    <span className="font-medium">{mission.name}</span>
                    <MilestoneBadge id={mission.arrives} />
                    {mission.durationTarget === null ? null : (
                      <span className="font-mono text-xs text-text-muted">
                        target {mission.durationTarget}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            </Row>
          </dl>
          <pre className="overflow-x-auto rounded-lg border border-border bg-surface-2 p-4 font-mono text-xs leading-5 text-text-muted">
            <code>{JSON.stringify(spec, null, 2)}</code>
          </pre>
        </section>

        <div className="flex flex-wrap items-center gap-3">
          <Link
            href="/?focus=mission"
            className="inline-flex h-9 items-center rounded-md border border-border bg-surface px-4 text-sm font-medium text-text shadow-sm hover:border-border-strong"
          >
            Try another input
          </Link>
          <Link
            href="/runs"
            className="inline-flex h-9 items-center rounded-md px-3 text-sm text-text-muted hover:bg-surface-2 hover:text-text"
          >
            {live ? "Your runs" : "What the run view will show"}
          </Link>
        </div>
      </div>
      <aside className="lg:pt-2">
        <RoadmapRail target={draft.firstArrival} />
      </aside>
    </div>
  );
}
