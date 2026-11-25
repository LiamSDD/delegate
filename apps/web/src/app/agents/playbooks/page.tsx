import type { Metadata } from "next";
import Link from "next/link";

import type { EvolutionLog } from "@delegate/evals/evolution";

import { Chip } from "@/components/run/primitives";
import { missionLabel } from "@/lib/m2-contract";
import { currentGuest } from "@/server/page-session";
import {
  evolutionDir,
  listPlaybookCards,
  loadEvolutionLogs,
  type PlaybookCard,
} from "@/server/playbooks";

export const metadata: Metadata = { title: "Playbooks" };

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

function keyLabel(key: string): string {
  const [mission = key, category] = key.split(":");
  return category === undefined ? missionLabel(mission) : `${missionLabel(mission)} · ${category}`;
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function armLabel(arm: EvolutionLog["decision"]["baseline"]): string {
  if (arm.mean === null) return "no trials";
  const ci =
    arm.lower === null || arm.upper === null ? "" : ` [${pct(arm.lower)}–${pct(arm.upper)}]`;
  return `${pct(arm.mean)}${ci} · n=${arm.n}`;
}

function PlaybookSection({ playbook }: { playbook: PlaybookCard }) {
  return (
    <li className="flex flex-col gap-3 px-4 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-md font-medium text-text">{keyLabel(playbook.key)}</h3>
        <Chip tone={playbook.scope === "house" ? "accent" : "neutral"}>
          {playbook.scope === "house" ? "house" : "this workspace"}
        </Chip>
        <span className="font-mono text-2xs text-text-subtle tabular">
          v{playbook.version} · {playbook.runs} run{playbook.runs === 1 ? "" : "s"}
          {playbook.origin === "shipped" ? " · shipped file" : ""} · updated{" "}
          <time dateTime={playbook.updatedAt}>
            {dateFormat.format(new Date(playbook.updatedAt))}
          </time>{" "}
          UTC
        </span>
      </div>
      {playbook.entries.length === 0 ? (
        <p className="text-sm text-text-muted">No entries kept yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {playbook.entries.map((entry) => (
            <li key={entry.id} className="flex min-w-0 flex-col gap-1 sm:flex-row sm:gap-3">
              <span className="flex shrink-0 items-center gap-1.5">
                <Chip tone={entry.polarity === "keep" ? "success" : "warning"}>
                  {entry.polarity}
                </Chip>
                <span className="font-mono text-2xs text-text-subtle">{entry.kind}</span>
              </span>
              <span className="min-w-0 text-sm break-words text-text">{entry.text}</span>
              <span className="shrink-0 font-mono text-2xs text-text-subtle tabular sm:ml-auto">
                {entry.polarity === "keep"
                  ? `${entry.score.toFixed(2)} [${entry.lower.toFixed(2)}–${entry.upper.toFixed(2)}] · `
                  : ""}
                {entry.evidence} run{entry.evidence === 1 ? "" : "s"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function EvolutionRow({ log }: { log: EvolutionLog }) {
  const promoted = log.decision.status === "promoted";
  const parent =
    log.kind === "prompt"
      ? `${log.parent.prompt.name}@${log.parent.prompt.version}`
      : `house v${log.parent.playbook.version}`;
  const child =
    log.kind === "prompt"
      ? `${log.child.prompt.name}@${log.child.prompt.version}`
      : `house v${log.child.playbook.version}`;
  return (
    <li className="flex flex-col gap-2 px-4 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={promoted ? "success" : "neutral"}>{log.decision.status}</Chip>
        <span className="font-mono text-xs text-text tabular">
          {parent} → {child}
        </span>
        <span className="font-mono text-2xs text-text-subtle">
          {log.kind} ·{" "}
          <time dateTime={log.startedAt}>{dateFormat.format(new Date(log.startedAt))}</time> UTC
        </span>
      </div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 font-mono text-2xs sm:grid-cols-3">
        <div className="flex gap-1.5">
          <dt className="text-text-subtle">baseline</dt>
          <dd className="text-text tabular">{armLabel(log.decision.baseline)}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-text-subtle">candidate</dt>
          <dd className="text-text tabular">{armLabel(log.decision.candidate)}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-text-subtle">red-team</dt>
          <dd className="text-text tabular">
            {log.redteam.successes}/{log.redteam.attacks} succeeded
          </dd>
        </div>
      </dl>
      <p className="text-xs text-pretty text-text-muted">{log.decision.reasons[0]}</p>
    </li>
  );
}

export default async function PlaybooksPage() {
  const guest = await currentGuest();
  const playbooks = guest === null ? [] : await listPlaybookCards(guest.app, guest.session);
  const evolution = loadEvolutionLogs(evolutionDir());

  return (
    <div className="mx-auto flex max-w-content flex-col gap-12 px-4 pt-16 pb-24 sm:px-6 md:pt-24">
      <header className="flex flex-col gap-4">
        <p className="font-mono text-2xs tracking-label text-text-subtle uppercase">
          <Link href="/agents" className="hover:text-text">
            Agents
          </Link>{" "}
          / Playbooks
        </p>
        <h1 className="font-serif text-display-md tracking-display text-balance">
          What the agents learned
        </h1>
        <p className="max-w-xl text-md text-pretty text-text-muted">
          After every run, code turns the event log into a few typed lessons: which plan shapes
          finished, which sources ended up cited, what the critic removed, which steps failed or
          were slow. Scores are Beta posterior means of run success with 95% intervals. The planner
          sees at most six entries per run, and the run log records which.
        </p>
      </header>

      <section aria-labelledby="playbooks-heading" className="flex flex-col gap-4">
        <h2 id="playbooks-heading" className="text-lg font-medium">
          Current playbooks
        </h2>
        {playbooks.length === 0 ? (
          <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-border-strong px-6 py-8">
            <p className="font-medium">No playbooks yet</p>
            <p className="max-w-lg text-sm text-text-muted">
              Finish a run in this workspace and its lessons appear here; the next run of the same
              mission starts with them. Nothing is shown until a run has actually finished.
            </p>
            <Link
              href="/?focus=mission"
              className="inline-flex h-9 items-center rounded-md bg-accent px-4 text-sm font-medium text-accent-fg hover:bg-accent/90"
            >
              Start a mission
            </Link>
          </div>
        ) : (
          <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
            {playbooks.map((playbook) => (
              <PlaybookSection key={`${playbook.scope}-${playbook.key}`} playbook={playbook} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="evolution-heading" className="flex flex-col gap-4">
        <h2 id="evolution-heading" className="text-lg font-medium">
          Evolution timeline
        </h2>
        <p className="max-w-xl text-sm text-pretty text-text-muted">
          <code className="font-mono text-xs">pnpm evolve --mission xray</code> proposes a planner
          prompt or house playbook revision and runs the eval set on both. A candidate is promoted
          only with a statistically supported win, no case regression, no extra hard-check failure
          and a red-team attack success rate of 0%.
        </p>
        {evolution.logs.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border-strong px-6 py-6 text-sm text-text-muted">
            No evolution has been run yet, so every prompt is still its hand-written version.
          </div>
        ) : (
          <ol className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
            {evolution.logs.map((log) => (
              <EvolutionRow key={log.id} log={log} />
            ))}
          </ol>
        )}
        {evolution.invalid.length === 0 ? null : (
          <p className="font-mono text-2xs text-warning">
            {evolution.invalid.length} evolution log
            {evolution.invalid.length === 1 ? "" : "s"} failed validation:{" "}
            {evolution.invalid.join(", ")}
          </p>
        )}
      </section>
    </div>
  );
}
