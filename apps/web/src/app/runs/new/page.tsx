import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { KindGlyph } from "@/components/kind-glyph";
import { AutoStartRun } from "@/components/run/auto-start";
import { RunAgainButton } from "@/components/run/run-status";
import { missionLabel } from "@/lib/m2-contract";
import { draftFromQuery } from "@/lib/mission-draft";
import { runRequestFor } from "@/lib/run-request";

export const metadata: Metadata = { title: "New run" };

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 border-t border-border py-3.5 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-6">
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
        <h1 className="font-serif text-display-md tracking-display">Nothing to run yet</h1>
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
  const company = detected.kind === "company";
  const request = company
    ? null
    : runRequestFor(detected, {
        companyMission: "automation-audit",
        rawInput: draft.input,
      });

  return (
    <div className="mx-auto flex max-w-content flex-col gap-12 px-6 pt-16 pb-24 md:pt-24">
      <header className="flex max-w-3xl flex-col gap-5">
        <p className="font-mono text-2xs tracking-label text-text-subtle uppercase">
          New run <span aria-hidden="true">·</span> {company ? "ready" : "starting"}
        </p>
        {company ? (
          <>
            <h1 className="font-serif text-display-md tracking-display text-balance">
              Analyse {detected.target}
            </h1>
            <p className="max-w-xl text-md text-text-muted text-pretty">
              Pick a mission: the AI Automation Audit ranks workflows to automate with an adjustable
              ROI model; the Company X-ray writes a cited brief.
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
              {detected.kind === "repo" ? `X-ray ${detected.target}` : "Working on your goal"}
            </h1>
            <p className="max-w-xl text-md text-text-muted text-pretty">
              The planner splits it into research, reading and verification steps; you see the plan
              before anything is fetched unless auto-approve is on.
            </p>
            {request === null ? null : <AutoStartRun request={request} />}
          </>
        )}
      </header>

      <section aria-labelledby="parsed" className="flex max-w-3xl flex-col gap-4">
        <h2 id="parsed" className="font-mono text-2xs tracking-label text-text-subtle uppercase">
          Parsed input
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
          <Row term="Mission">
            {request === null
              ? "Automation Audit or Company X-ray"
              : missionLabel(request.missionId)}
          </Row>
        </dl>
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
          Your runs
        </Link>
      </div>
    </div>
  );
}
