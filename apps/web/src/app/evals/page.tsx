import path from "node:path";

import type { Metadata } from "next";
import type { ReactNode } from "react";

import { wilsonInterval, type ProportionInterval } from "@delegate/evals/results";

import { ParetoChart } from "@/components/evals/pareto-chart";
import {
  buildDashboard,
  evalResultsDir,
  loadEvalResults,
  loadRedteam,
  type Calibration,
  type FrontierPoint,
  type MissionScore,
  type RedteamState,
} from "@/server/eval-results";

export const metadata: Metadata = { title: "Evals" };
export const dynamic = "force-static";

const MISSION_NAMES: Record<string, string> = { xray: "Company X-ray" };

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

function missionName(mission: string): string {
  return MISSION_NAMES[mission] ?? mission;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function Proportion({ value }: { value: ProportionInterval | null }) {
  if (value === null) return <span className="text-text-subtle">no data</span>;
  return (
    <span className="tabular">
      <span className="text-text">{pct(value.rate)}</span>{" "}
      <span className="text-text-subtle">
        [{pct(value.lower)}, {pct(value.upper)}] n={value.n}
      </span>
    </span>
  );
}

function seconds(ms: number | null): string {
  return ms === null ? "no data" : `${(ms / 1000).toFixed(1)} s`;
}

function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-xs bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-text">
      {children}
    </code>
  );
}

function Section({
  id,
  index,
  label,
  title,
  note,
  children,
}: {
  id: string;
  index: string;
  label: string;
  title: string;
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-5">
      <div className="flex flex-col gap-2 border-t border-border pt-6">
        <p className="font-mono text-2xs tracking-label text-text-subtle uppercase tabular">
          {index} <span aria-hidden="true">/</span> {label}
        </p>
        <h2 id={id} className="font-serif text-display-sm tracking-display text-balance">
          {title}
        </h2>
        {note === undefined ? null : (
          <p className="max-w-2xl text-sm text-text-muted text-pretty">{note}</p>
        )}
      </div>
      {children}
    </section>
  );
}

function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-border-strong px-5 py-6">
      <h3 className="text-base font-medium">{title}</h3>
      <div className="max-w-xl text-sm text-text-muted text-pretty">{children}</div>
    </div>
  );
}

function ModeBadge({ mode }: { mode: "live" | "replay" }) {
  return mode === "replay" ? (
    <span className="rounded-sm bg-warning-soft px-1.5 font-mono text-2xs text-warning">
      Replay
    </span>
  ) : (
    <span className="rounded-sm bg-success-soft px-1.5 font-mono text-2xs text-success">Live</span>
  );
}

function Scoreboard({ missions }: { missions: readonly MissionScore[] }) {
  if (missions.length === 0) {
    return (
      <Empty title="No eval results committed yet">
        <p>
          Run <Code>pnpm eval --mission xray</Code>, then commit the file it writes to{" "}
          <Code>packages/evals/results/xray/</Code>. Nothing here is estimated: the scoreboard only
          shows recorded trials.
        </p>
      </Empty>
    );
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-surface shadow-sm">
      <table className="w-full min-w-[46rem] text-left text-sm">
        <caption className="sr-only">Latest eval result per mission</caption>
        <thead className="border-b border-border">
          <tr className="font-mono text-2xs tracking-label text-text-subtle uppercase">
            <th scope="col" className="px-4 py-3 font-normal">
              Mission
            </th>
            <th scope="col" className="px-4 py-3 font-normal">
              Pass rate (95% CI)
            </th>
            <th scope="col" className="px-4 py-3 font-normal">
              Score (mean ± 95% CI)
            </th>
            <th scope="col" className="px-4 py-3 font-normal">
              Citations verified
            </th>
            <th scope="col" className="px-4 py-3 font-normal">
              Latency p50
            </th>
            <th scope="col" className="px-4 py-3 font-normal">
              Latest result
            </th>
          </tr>
        </thead>
        <tbody>
          {missions.map(({ mission, latest, board, runs }) => (
            <tr key={mission} className="border-b border-border align-top last:border-b-0">
              <th scope="row" className="px-4 py-3 font-medium">
                {missionName(mission)}
                <p className="mt-1 font-mono text-2xs font-normal text-text-subtle">
                  {latest.dataset.name} v{latest.dataset.version} · {latest.trialsPerCase} trials
                  per case
                </p>
              </th>
              <td className="px-4 py-3 font-mono text-xs">
                <Proportion value={board.passRate} />
              </td>
              <td className="px-4 py-3 font-mono text-xs tabular">
                {board.score === null ? (
                  <span className="text-text-subtle">no data</span>
                ) : (
                  <>
                    <span className="text-text">{board.score.mean.toFixed(2)}</span>{" "}
                    <span className="text-text-subtle">
                      {board.score.lower === null || board.score.upper === null
                        ? `n=${board.score.n}, no CI`
                        : `± ${((board.score.upper - board.score.lower) / 2).toFixed(2)} n=${board.score.n}`}
                    </span>
                  </>
                )}
              </td>
              <td className="px-4 py-3 font-mono text-xs">
                <Proportion value={board.citationAccuracy} />
              </td>
              <td className="px-4 py-3 font-mono text-xs text-text-muted tabular">
                {seconds(board.p50LatencyMs)}
              </td>
              <td className="px-4 py-3 font-mono text-xs text-text-muted">
                <span className="flex flex-wrap items-center gap-2">
                  <ModeBadge mode={latest.mode} />
                  <time dateTime={latest.finishedAt}>
                    {dateFormat.format(new Date(latest.finishedAt))}
                  </time>
                </span>
                <span className="mt-1 block text-2xs text-text-subtle">
                  {runs} result {runs === 1 ? "file" : "files"} ·{" "}
                  {Object.entries(latest.promptVersions)
                    .map(([name, version]) => `${name}@${version}`)
                    .join(", ")}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Frontier({ points }: { points: readonly FrontierPoint[] }) {
  if (points.length === 0) {
    return (
      <Empty title="No points to plot yet">
        <p>
          Each committed result file becomes one point: tokens per trial against pass rate. Run{" "}
          <Code>pnpm eval --mission xray</Code> with different models or prompt versions to fill the
          chart.
        </p>
      </Empty>
    );
  }
  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4 shadow-sm">
      <ul className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-2xs text-text-muted">
        <li className="flex items-center gap-2">
          <span aria-hidden="true" className="size-2.5 rounded-full bg-accent" />
          On the Pareto frontier
        </li>
        <li className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="size-2.5 rounded-full border-2 border-text-subtle bg-surface"
          />
          Dominated (another run is cheaper and at least as good)
        </li>
      </ul>
      <ParetoChart points={points} />
      <details className="text-sm">
        <summary className="cursor-pointer font-mono text-2xs tracking-label text-text-subtle uppercase">
          Table view
        </summary>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[36rem] text-left font-mono text-xs">
            <thead>
              <tr className="text-text-subtle">
                <th scope="col" className="py-1.5 pr-4 font-normal">
                  Result
                </th>
                <th scope="col" className="py-1.5 pr-4 font-normal">
                  Configuration
                </th>
                <th scope="col" className="py-1.5 pr-4 font-normal">
                  Tokens / trial
                </th>
                <th scope="col" className="py-1.5 pr-4 font-normal">
                  Spend / trial
                </th>
                <th scope="col" className="py-1.5 pr-4 font-normal">
                  Pass rate
                </th>
                <th scope="col" className="py-1.5 font-normal">
                  Frontier
                </th>
              </tr>
            </thead>
            <tbody>
              {points.map((point) => (
                <tr key={point.id} className="border-t border-border">
                  <td className="py-1.5 pr-4">
                    {point.id} {point.mode === "replay" ? "(Replay)" : ""}
                  </td>
                  <td className="py-1.5 pr-4 text-text-muted">{point.label}</td>
                  <td className="py-1.5 pr-4 tabular">{Math.round(point.tokensPerTrial)}</td>
                  <td className="py-1.5 pr-4 tabular">
                    ${(point.costMicroUsdPerTrial / 1_000_000).toFixed(4)}
                  </td>
                  <td className="py-1.5 pr-4 tabular">
                    {pct(point.passRate)} (n={point.n})
                  </td>
                  <td className="py-1.5">{point.onFrontier ? "yes" : "no"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

function CalibrationBlock({ calibration }: { calibration: readonly Calibration[] }) {
  if (calibration.length === 0) {
    return (
      <Empty title="Nothing to calibrate yet">
        <p>
          Calibration needs judged trials and human labels. Run{" "}
          <Code>pnpm eval --mission xray</Code>, then add labels to{" "}
          <Code>packages/evals/datasets/company-xray/human-labels.v1.jsonl</Code>.
        </p>
      </Empty>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {calibration.map(({ mission, resultId, agreement }) => (
        <div key={mission} className="rounded-xl border border-border bg-surface p-4 shadow-sm">
          <p className="font-mono text-2xs text-text-subtle">
            {missionName(mission)} · {resultId}
          </p>
          {agreement.status === "no_human_labels" ? (
            <p className="mt-2 text-sm text-text-muted">
              No human labels yet, so judge-human agreement is not measured. Add labels to{" "}
              <Code>packages/evals/datasets/company-xray/human-labels.v1.jsonl</Code> and re-run the
              eval.
            </p>
          ) : agreement.status === "no_matching_judgements" ? (
            <p className="mt-2 text-sm text-text-muted">
              {agreement.labels} human labels exist, but none match a judged trial in this result.
            </p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <p className="mb-2 text-sm text-text-muted">
                {agreement.matched} of {agreement.labels} human labels matched a judged trial.
              </p>
              <table className="w-full min-w-[32rem] text-left font-mono text-xs">
                <thead>
                  <tr className="text-text-subtle">
                    <th scope="col" className="py-1.5 pr-4 font-normal">
                      Criterion
                    </th>
                    <th scope="col" className="py-1.5 pr-4 font-normal">
                      n
                    </th>
                    <th scope="col" className="py-1.5 pr-4 font-normal">
                      Exact match (95% CI)
                    </th>
                    <th scope="col" className="py-1.5 pr-4 font-normal">
                      Within 1
                    </th>
                    <th scope="col" className="py-1.5 font-normal">
                      Cohen&apos;s kappa (95% CI)
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {agreement.criteria.map((row) => (
                    <tr key={row.criterion} className="border-t border-border">
                      <td className="py-1.5 pr-4">{row.criterion}</td>
                      <td className="py-1.5 pr-4 tabular">{row.n}</td>
                      <td className="py-1.5 pr-4">
                        <Proportion
                          value={wilsonInterval(Math.round(row.exactMatchRate * row.n), row.n)}
                        />
                      </td>
                      <td className="py-1.5 pr-4 tabular">{pct(row.withinOneRate)}</td>
                      <td className="py-1.5 tabular">
                        {row.kappa === null ? (
                          <span className="text-text-subtle">n/a</span>
                        ) : (
                          <>
                            {row.kappa.toFixed(2)}{" "}
                            <span className="text-text-subtle">
                              {row.kappaLower === null || row.kappaUpper === null
                                ? ""
                                : `[${row.kappaLower.toFixed(2)}, ${row.kappaUpper.toFixed(2)}]`}
                            </span>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function Redteam({ state }: { state: RedteamState }) {
  if (state.status !== "ok") {
    return (
      <Empty
        title={
          state.status === "absent"
            ? "The red-team suite has not run"
            : "Red-team report unreadable"
        }
      >
        <p>
          {state.status === "absent"
            ? "No attack success rate is shown until there is a recorded run. "
            : "packages/evals/results/redteam.json does not match the red-team result schema. "}
          Run <Code>pnpm redteam</Code> to write <Code>packages/evals/results/redteam.json</Code>.
        </p>
      </Empty>
    );
  }
  const { report } = state;
  const asr = report.attacks === 0 ? null : wilsonInterval(report.successes, report.attacks);
  return (
    <div className="grid gap-6 rounded-xl border border-border bg-surface p-5 shadow-sm md:grid-cols-[16rem_minmax(0,1fr)]">
      <div className="flex flex-col gap-2">
        <p className="font-mono text-2xs tracking-label text-text-subtle uppercase">
          Attack success rate
        </p>
        <p
          className={`font-serif text-display-md tracking-display tabular ${report.successes === 0 ? "text-success" : "text-danger"}`}
        >
          {pct(report.asr)}
        </p>
        <p className="font-mono text-xs text-text-muted tabular">
          {report.successes} of {report.attacks} attacks succeeded
          {asr === null ? "" : ` · 95% CI [${pct(asr.lower)}, ${pct(asr.upper)}]`}
        </p>
        <p className="font-mono text-2xs text-text-subtle">
          {report.suite} ·{" "}
          <time dateTime={report.generatedAt}>
            {Number.isNaN(Date.parse(report.generatedAt))
              ? report.generatedAt
              : dateFormat.format(new Date(report.generatedAt))}
          </time>
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[20rem] text-left font-mono text-xs">
          <caption className="sr-only">Attacks by category</caption>
          <thead>
            <tr className="text-text-subtle">
              <th scope="col" className="py-1.5 pr-4 font-normal">
                Category
              </th>
              <th scope="col" className="py-1.5 pr-4 font-normal">
                Attacks
              </th>
              <th scope="col" className="py-1.5 font-normal">
                Succeeded
              </th>
            </tr>
          </thead>
          <tbody>
            {report.byCategory.map((row) => (
              <tr key={row.category} className="border-t border-border">
                <td className="py-1.5 pr-4">{row.category}</td>
                <td className="py-1.5 pr-4 tabular">{row.attacks}</td>
                <td
                  className={`py-1.5 tabular ${row.successes === 0 ? "text-text-muted" : "text-danger"}`}
                >
                  {row.successes}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function EvalsPage() {
  const resultsDir = evalResultsDir();
  const dashboard = buildDashboard(loadEvalResults(resultsDir));
  const redteam = loadRedteam(path.join(resultsDir, "redteam.json"));

  return (
    <div className="mx-auto flex max-w-content flex-col gap-14 px-4 pt-16 pb-24 sm:px-6 md:pt-24">
      <header className="flex flex-col gap-4">
        <p className="font-mono text-2xs tracking-label text-text-subtle uppercase">Evals</p>
        <h1 className="font-serif text-display-md tracking-display text-balance">
          Quality, measured with error bars
        </h1>
        <p className="max-w-2xl text-md text-text-muted text-pretty">
          Built at deploy time from the result files committed under{" "}
          <Code>packages/evals/results/</Code>. Pass rates carry Wilson 95% intervals and the number
          of trials behind them; nothing is sampled or filled in.
        </p>
      </header>

      {dashboard.invalid.length > 0 ? (
        <p className="rounded-lg border border-warning/40 bg-warning-soft px-4 py-3 text-sm text-warning">
          Skipped {dashboard.invalid.length} result{" "}
          {dashboard.invalid.length === 1 ? "file" : "files"} that did not match the schema:{" "}
          {dashboard.invalid.join(", ")}
        </p>
      ) : null}

      <Section
        id="scoreboard"
        index="01"
        label="Scoreboard"
        title="Per mission, latest run"
        note="A trial passes when the run completes and every hard check holds. Citations verified means every cited URL resolved and every quote was found verbatim in the fetched page; errored trials are not counted."
      >
        <Scoreboard missions={dashboard.missions} />
      </Section>

      <Section
        id="pareto"
        index="02"
        label="Cost against quality"
        title="Pareto frontier across result files"
        note="Each point is one committed result. The default model chain is keyless, so spend is $0 and tokens per trial stand in for cost; the table view shows both."
      >
        <Frontier points={dashboard.frontier} />
      </Section>

      <Section
        id="calibration"
        index="03"
        label="Judge calibration"
        title="Does the LLM judge agree with people?"
        note="Agreement between judge scores and human labels on the same trials, per criterion. Kappa intervals use the asymptotic standard error, so treat them as rough below about 30 labels."
      >
        <CalibrationBlock calibration={dashboard.calibration} />
      </Section>

      <Section
        id="redteam"
        index="04"
        label="Red team"
        title="Attack success rate, target 0%"
        note="Attacks by category from the red-team suite. Any success fails the local gate."
      >
        <Redteam state={redteam} />
      </Section>
    </div>
  );
}
