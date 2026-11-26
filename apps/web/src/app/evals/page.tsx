import path from "node:path";

import type { Metadata } from "next";
import type { ReactNode } from "react";

import {
  wilsonInterval,
  type MeanInterval,
  type ProportionInterval,
  type ResultAgreement,
  type ResultMetric,
} from "@delegate/evals/results";

import { LearnedRoutingTable } from "@/components/evals/learned-routing";
import { ParetoChart } from "@/components/evals/pareto-chart";
import { Code, Empty, evalDateFormat as dateFormat, pct } from "@/components/evals/parts";
import { PromptVersions } from "@/components/evals/prompt-versions";
import { Training } from "@/components/evals/training";
import {
  buildDashboard,
  evalResultsDir,
  loadEvalResults,
  loadEvalsLearning,
  loadRedteam,
  type Calibration,
  type EvolutionRow,
  type FrontierPoint,
  type MissionFrontier,
  type MissionRow,
  type RedteamState,
} from "@/server/eval-results";

export const metadata: Metadata = { title: "Evals" };
export const dynamic = "force-static";

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

function ModeBadge({ mode }: { mode: "live" | "replay" }) {
  return mode === "replay" ? (
    <span className="rounded-sm bg-warning-soft px-1.5 font-mono text-2xs text-warning">
      Replay
    </span>
  ) : (
    <span className="rounded-sm bg-success-soft px-1.5 font-mono text-2xs text-success">Live</span>
  );
}

const METRIC_LABELS: Record<string, { label: string; unit: "share" | "count" | "eur" }> = {
  claims: { label: "claims", unit: "count" },
  citations: { label: "citations", unit: "count" },
  sectionsCovered: { label: "sections covered", unit: "count" },
  opportunities: { label: "opportunities", unit: "count" },
  eurPerMonth: { label: "estimated €/month", unit: "eur" },
  departmentRecall: { label: "department hints found", unit: "share" },
  workflowRecall: { label: "workflow hints found", unit: "share" },
  verifiedShare: { label: "critic-verified", unit: "share" },
  answerAccuracy: { label: "answers correct", unit: "share" },
  falseRefusalRate: { label: "false refusals", unit: "share" },
  outOfScopeRefusalRate: { label: "out-of-scope refused", unit: "share" },
  citedAnswerRate: { label: "answers cited", unit: "share" },
  factRecall: { label: "expected facts found", unit: "share" },
  improvements: { label: "improvements", unit: "count" },
  actions: { label: "actions", unit: "count" },
  targetResolved: { label: "target resolved", unit: "share" },
};

const euro = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0,
});

function MetricList({ metrics }: { metrics: readonly [string, ResultMetric][] }) {
  const shown = metrics.flatMap(([name, value]) => {
    const meta = METRIC_LABELS[name];
    return meta === undefined ? [] : [{ name, value, meta }];
  });
  if (shown.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-2xs font-normal text-text-muted">
      {shown.map(({ name, value, meta }) => (
        <li key={name} className="tabular">
          {meta.unit === "share"
            ? pct(value.mean)
            : meta.unit === "eur"
              ? euro.format(value.mean)
              : value.mean.toFixed(1)}{" "}
          <span className="text-text-subtle">
            {meta.label} (n={value.n})
          </span>
        </li>
      ))}
    </ul>
  );
}

function Scoreboard({ missions }: { missions: readonly MissionRow[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-surface shadow-sm">
      <table className="w-full min-w-[52rem] text-left text-sm">
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
              Judge (0-1)
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
          {missions.map((row) => (
            <tr key={row.mission} className="border-b border-border align-top last:border-b-0">
              <th scope="row" className="px-4 py-3 font-medium">
                {row.title}
                <p className="mt-1 font-mono text-2xs font-normal text-text-subtle">
                  {row.status === "ok"
                    ? `${row.latest.dataset.name} v${row.latest.dataset.version} · ${row.latest.trialsPerCase} trials per case`
                    : `dataset ${row.dataset}`}
                </p>
                {row.status === "ok" ? <MetricList metrics={row.metrics} /> : null}
              </th>
              {row.status === "no_results" ? (
                <td colSpan={6} className="px-4 py-3 text-sm text-text-muted">
                  No results committed yet, so nothing is shown. Run{" "}
                  <Code>pnpm eval --mission {row.mission}</Code> and commit the file it writes to{" "}
                  <Code>packages/evals/results/{row.mission}/</Code>.
                </td>
              ) : (
                <>
                  <td className="px-4 py-3 font-mono text-xs">
                    <Proportion value={row.board.passRate} />
                  </td>
                  <td className="px-4 py-3 font-mono text-xs tabular">
                    <MeanValue value={row.board.score} />
                  </td>
                  <td className="px-4 py-3 font-mono text-xs tabular">
                    <MeanValue value={row.board.judge} />
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">
                    <Proportion value={row.board.citationAccuracy} />
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-text-muted tabular">
                    {seconds(row.board.p50LatencyMs)}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-text-muted">
                    <span className="flex flex-wrap items-center gap-2">
                      <ModeBadge mode={row.latest.mode} />
                      <time dateTime={row.latest.finishedAt}>
                        {dateFormat.format(new Date(row.latest.finishedAt))}
                      </time>
                    </span>
                    <span className="mt-1 block text-2xs text-text-subtle">
                      {row.runs} result {row.runs === 1 ? "file" : "files"}
                      {row.liveRuns === 0 ? " · no live run yet" : ` · ${row.liveRuns} live`}
                    </span>
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MeanValue({ value }: { value: MeanInterval | null }) {
  if (value === null) return <span className="text-text-subtle">no data</span>;
  return (
    <>
      <span className="text-text">{value.mean.toFixed(2)}</span>{" "}
      <span className="text-text-subtle">
        {value.lower === null || value.upper === null
          ? `n=${value.n}, no CI`
          : `± ${((value.upper - value.lower) / 2).toFixed(2)} n=${value.n}`}
      </span>
    </>
  );
}

function FrontierTable({ points }: { points: readonly FrontierPoint[] }) {
  return (
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
  );
}

function Frontiers({ frontiers }: { frontiers: readonly MissionFrontier[] }) {
  const plotted = frontiers.filter((entry) => entry.points.length > 0);
  const empty = frontiers.filter((entry) => entry.points.length === 0);
  return (
    <div className="flex flex-col gap-4">
      {plotted.length === 0 ? (
        <Empty title="No points to plot yet">
          <p>
            Each committed result file becomes one point: tokens per trial against pass rate. Run{" "}
            <Code>pnpm eval --mission all</Code> with different models or prompt versions to fill
            the charts.
          </p>
        </Empty>
      ) : (
        <ul className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-2xs text-text-muted">
          <li className="flex items-center gap-2">
            <span aria-hidden="true" className="size-2.5 rounded-full bg-accent" />
            On the mission&apos;s Pareto frontier
          </li>
          <li className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="size-2.5 rounded-full border-2 border-text-subtle bg-surface"
            />
            Dominated (another configuration is cheaper and at least as good)
          </li>
        </ul>
      )}
      {plotted.map((entry) => (
        <div
          key={entry.mission}
          className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-sm"
        >
          <h3 className="text-base font-medium">
            {entry.title}{" "}
            <span className="font-mono text-2xs font-normal text-text-subtle">
              {entry.points.length} {entry.points.length === 1 ? "result" : "results"}
            </span>
          </h3>
          <ParetoChart points={entry.points} />
          <FrontierTable points={entry.points} />
        </div>
      ))}
      {plotted.length > 0 && empty.length > 0 ? (
        <p className="text-sm text-text-muted">
          No results yet for {empty.map((entry) => entry.title).join(", ")}.
        </p>
      ) : null}
    </div>
  );
}

function AgreementTable({ agreement }: { agreement: ResultAgreement }) {
  if (agreement.status === "no_human_labels")
    return (
      <p className="mt-2 text-sm text-text-muted">
        No human labels yet, so judge-human agreement is not measured.
      </p>
    );
  if (agreement.status === "no_matching_judgements")
    return (
      <p className="mt-2 text-sm text-text-muted">
        {agreement.labels} human labels exist, but none match a judged trial still on disk.
      </p>
    );
  return (
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
                <Proportion value={wilsonInterval(Math.round(row.exactMatchRate * row.n), row.n)} />
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
  );
}

function CalibrationBlock({ calibration }: { calibration: readonly Calibration[] }) {
  return (
    <div className="flex flex-col gap-4">
      {calibration.map((entry) => (
        <div
          key={entry.mission}
          className="rounded-xl border border-border bg-surface p-4 shadow-sm"
        >
          <p className="font-mono text-2xs text-text-subtle">
            {entry.title}
            {entry.source === "none" ? "" : ` · ${entry.reference}`}
          </p>
          {entry.source === "none" ? (
            <p className="mt-2 text-sm text-text-muted">
              No judged trials yet. Run <Code>pnpm eval --mission {entry.mission}</Code>, then label
              trials with <Code>pnpm label --mission {entry.mission}</Code>.
            </p>
          ) : (
            <AgreementTable agreement={entry.agreement} />
          )}
          {entry.source !== "none" && entry.agreement.status !== "ok" ? (
            <p className="mt-2 text-sm text-text-muted">
              Label stored trials with <Code>pnpm label --mission {entry.mission}</Code>; labels go
              to <Code>packages/evals/datasets/{entry.dataset}/human-labels.v1.jsonl</Code>.
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function score(value: number | null): string {
  return value === null ? "–" : value.toFixed(2);
}

function Evolution({ rows }: { rows: readonly EvolutionRow[] }) {
  if (rows.length === 0)
    return (
      <Empty title="No evolution runs recorded">
        <p>
          <Code>pnpm evolve</Code> proposes a prompt or playbook revision, evaluates parent and
          child on the same cases, runs the red-team suite and promotes the child only on a
          significant improvement with no regression. Each run writes a log to{" "}
          <Code>packages/evals/results/evolution/</Code>; none is committed yet.
        </p>
      </Empty>
    );
  return (
    <ol className="flex flex-col gap-3">
      {rows.map((row) => (
        <li key={row.id} className="rounded-xl border border-border bg-surface p-4 shadow-sm">
          <div className="flex flex-wrap items-center gap-2 font-mono text-2xs text-text-subtle">
            <span
              className={`rounded-sm px-1.5 ${row.status === "promoted" ? "bg-success-soft text-success" : "bg-surface-2 text-text-muted"}`}
            >
              {row.status === "promoted" ? "Promoted" : "Rejected"}
            </span>
            <span>
              {row.mission} · {row.kind}
            </span>
            <time dateTime={row.finishedAt}>{dateFormat.format(new Date(row.finishedAt))}</time>
          </div>
          <p className="mt-2 font-mono text-xs text-text">
            {row.parent} <span aria-hidden="true">→</span>
            <span className="sr-only">to</span> {row.child}
          </p>
          <p className="mt-1 font-mono text-xs text-text-muted tabular">
            score {score(row.baselineMean)} (n={row.n.baseline}) → {score(row.candidateMean)} (n=
            {row.n.candidate}){row.pValue === null ? "" : ` · p=${row.pValue.toFixed(3)}`} ·
            red-team ASR {pct(row.asr)}
          </p>
          <ul className="mt-2 list-disc pl-5 text-sm text-text-muted">
            {row.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          {row.promotedFile === null ? null : (
            <p className="mt-2 font-mono text-2xs text-text-subtle">wrote {row.promotedFile}</p>
          )}
        </li>
      ))}
    </ol>
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
            : "packages/evals/results/redteam.json does not match the red-team report schema. "}
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
  const learning = loadEvalsLearning();
  const invalid = [...dashboard.invalid, ...learning.training.invalid];

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
          of trials behind them; nothing is sampled or filled in, and a mission without a recorded
          run says so.
        </p>
      </header>

      {invalid.length > 0 ? (
        <p className="rounded-lg border border-warning/40 bg-warning-soft px-4 py-3 text-sm text-warning">
          Skipped {invalid.length} result {invalid.length === 1 ? "file" : "files"} that did not
          match the schema: {invalid.join(", ")}
        </p>
      ) : null}

      <Section
        id="scoreboard"
        index="01"
        label="Scoreboard"
        title="Per mission, latest run"
        note="A trial passes when the run completes and every deterministic check it was graded on holds; hard checks (schema, citations, refusals) also fail the gate. Citations verified counts trials whose citations all resolved; errored trials are not counted. Mission metrics are means over trials."
      >
        <Scoreboard missions={dashboard.missions} />
      </Section>

      <Section
        id="pareto"
        index="02"
        label="Cost against quality"
        title="Pareto frontier per mission, across versions"
        note="Each point is one committed result: a model chain and set of prompt versions. Missions are plotted separately because their token scales differ. The default chain is keyless, so spend is $0 and tokens per trial stand in for cost; the table view shows both."
      >
        <Frontiers frontiers={dashboard.frontiers} />
      </Section>

      <Section
        id="calibration"
        index="03"
        label="Judge calibration"
        title="Does the LLM judge agree with people?"
        note="Agreement between judge scores and blind human labels on the same trials, per criterion and mission. Kappa intervals use the asymptotic standard error, so treat them as rough below about 30 labels."
      >
        <CalibrationBlock calibration={dashboard.calibration} />
      </Section>

      <Section
        id="training"
        index="04"
        label="Training"
        title="Rounds that had to earn their promotion"
        note="Each step compares one candidate with its parent on the same cases. It is promoted only when the pooled and the paired score difference are both significant, no case regresses, no new hard check fails, the red-team suite stays at 0% and the same models served both arms. The mark shows the mean per-case difference with its 95% interval against zero."
      >
        <Training rows={learning.training.rows} lineage={learning.training.lineage} />
      </Section>

      <Section
        id="prompts"
        index="05"
        label="Live prompts"
        title="The prompt versions each mission runs"
        note="The runtime loads the files named in RUNTIME_PROMPT_FILES. Training writes a promoted prompt as a new version file and never edits a shipped one; it goes live when the pointer changes in a reviewed commit. A promoted house playbook is live as soon as it is deployed."
      >
        <PromptVersions missions={learning.prompts} />
      </Section>

      <Section
        id="routing"
        index="06"
        label="Learned routing"
        title="Which model serves each role best"
        note="Pass rates per mission, role and model from the trials each model served, with Wilson 95% intervals. An order is learned only when every ranked model has enough trials and the intervals do not overlap; otherwise the configured order stands and the reason is given."
      >
        <LearnedRoutingTable state={learning.routing} />
      </Section>

      <Section
        id="evolution"
        index="07"
        label="Evolution"
        title="Prompt and playbook lineage"
        note="Every proposed revision, the parent it came from, the eval comparison and why it was promoted or rejected."
      >
        <Evolution rows={dashboard.evolution} />
      </Section>

      <Section
        id="redteam"
        index="08"
        label="Red team"
        title="Attack success rate, target 0%"
        note="Attacks by category from the red-team suite. Any success fails the local gate."
      >
        <Redteam state={redteam} />
      </Section>
    </div>
  );
}
