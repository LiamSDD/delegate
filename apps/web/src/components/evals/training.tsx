import type {
  MissionLineage,
  TrainingArmView,
  TrainingDelta,
  TrainingRow,
} from "@/server/eval-results";

import { Badge, Code, Empty, evalDateFormat } from "./parts";

const STATUS: Record<
  TrainingRow["status"],
  { label: string; tone: "success" | "warning" | "neutral" }
> = {
  promoted: { label: "Promoted", tone: "success" },
  rejected: { label: "Rejected", tone: "neutral" },
  inconclusive: { label: "Inconclusive", tone: "warning" },
};

const SOURCE: Record<TrainingArmView["source"], string> = {
  run: "run in this step",
  cache: "reused arm",
  result: "reused result file",
};

function signed(value: number): string {
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(3)}`;
}

function minutes(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 60_000).toFixed(1)} min`;
}

const tokenFormat = new Intl.NumberFormat("en-GB", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function deltaDomain(delta: Pick<TrainingDelta, "value" | "lower" | "upper">): number {
  const extent = Math.max(
    Math.abs(delta.value),
    Math.abs(delta.lower ?? delta.value),
    Math.abs(delta.upper ?? delta.value),
  );
  return Math.min(1, Math.max(0.05, extent * 1.15));
}

function DeltaMark({ delta }: { delta: TrainingDelta }) {
  const width = 168;
  const height = 20;
  const pad = 8;
  const domain = deltaDomain(delta);
  const x = (value: number) =>
    pad +
    ((Math.max(-domain, Math.min(domain, value)) + domain) / (2 * domain)) * (width - 2 * pad);
  const interval =
    delta.lower === null || delta.upper === null
      ? "no interval"
      : `95% interval ${signed(delta.lower)} to ${signed(delta.upper)}`;
  const label = `Score difference ${signed(delta.value)}, ${interval}; the tick marks zero`;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${width} ${height}`}
      className="h-5 w-42 shrink-0"
    >
      <title>{label}</title>
      <line
        x1={pad}
        x2={width - pad}
        y1={height / 2}
        y2={height / 2}
        stroke="var(--border)"
        strokeWidth={1}
      />
      <line
        x1={x(0)}
        x2={x(0)}
        y1={2}
        y2={height - 2}
        stroke="var(--border-strong)"
        strokeWidth={1}
      />
      {delta.lower === null || delta.upper === null ? null : (
        <line
          x1={x(delta.lower)}
          x2={x(delta.upper)}
          y1={height / 2}
          y2={height / 2}
          stroke="var(--accent)"
          strokeWidth={2}
          strokeLinecap="round"
        />
      )}
      <circle
        cx={x(delta.value)}
        cy={height / 2}
        r={4}
        fill="var(--accent)"
        stroke="var(--surface)"
        strokeWidth={2}
      />
    </svg>
  );
}

function Arm({ arm }: { arm: TrainingArmView }) {
  if (arm.mean === null) return <span className="text-text-subtle">no graded trial</span>;
  return (
    <>
      <span className="text-text">{arm.mean.toFixed(2)}</span>{" "}
      <span className="text-text-subtle">
        {arm.lower === null || arm.upper === null
          ? `n=${arm.n}`
          : `[${arm.lower.toFixed(2)}, ${arm.upper.toFixed(2)}] n=${arm.n}`}
        {arm.errored === 0 ? "" : `, ${arm.errored} errored`}
      </span>
    </>
  );
}

function Step({ row }: { row: TrainingRow }) {
  const status = STATUS[row.status];
  return (
    <li className="rounded-xl border border-border bg-surface p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2 font-mono text-2xs text-text-subtle">
        <Badge tone={status.tone}>{status.label}</Badge>
        <span>
          {row.title} · round {row.round} · {row.kind}
        </span>
        <time dateTime={row.finishedAt}>{evalDateFormat.format(new Date(row.finishedAt))}</time>
      </div>
      <p className="mt-2 font-mono text-xs break-words text-text">{row.change}</p>
      <p className="mt-1 font-mono text-xs text-text-muted tabular">
        score <Arm arm={row.baseline} /> <span aria-hidden="true">→</span>
        <span className="sr-only">to</span>{" "}
        {row.candidate === null ? (
          <span className="text-text-subtle">no candidate arm</span>
        ) : (
          <Arm arm={row.candidate} />
        )}
      </p>
      {row.delta === null ? null : (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <DeltaMark delta={row.delta} />
          <p className="font-mono text-xs text-text-muted tabular">
            <span className="text-text">Δ {signed(row.delta.value)}</span>{" "}
            {row.delta.lower === null || row.delta.upper === null
              ? ""
              : `[${signed(row.delta.lower)}, ${signed(row.delta.upper)}] `}
            {row.delta.kind === "paired" ? "paired over" : "over"} {row.delta.units} · p ={" "}
            {row.delta.pValue.toFixed(3)} (needs &lt; {row.alpha.toFixed(3)}
            {row.comparisons > 1 ? `, try ${row.comparisons} against this baseline` : ""})
          </p>
        </div>
      )}
      <ul className="mt-2 list-disc pl-5 text-sm text-text-muted">
        {row.reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
      <p className="mt-2 font-mono text-2xs break-words text-text-subtle tabular">
        baseline {SOURCE[row.baseline.source]}
        {row.candidate === null ? "" : ` · candidate ${SOURCE[row.candidate.source]}`} ·{" "}
        {tokenFormat.format(row.tokens)} tokens · {minutes(row.wallMs)}
        {row.redteam === null ? "" : ` · red team ${row.redteam}`}
      </p>
      {row.models.length === 0 ? null : (
        <p className="mt-1 font-mono text-2xs break-words text-text-subtle">
          served by {row.models.join(", ")}
        </p>
      )}
      {row.promotedFile === null ? null : (
        <p className="mt-2 font-mono text-2xs break-words text-text-subtle">
          wrote {row.promotedFile}
          {row.apply === null ? "" : ` · ${row.apply}`}
        </p>
      )}
    </li>
  );
}

function Chain({
  label,
  steps,
}: {
  label: string;
  steps: MissionLineage["prompts"][number]["steps"];
}) {
  const [first] = steps;
  if (first === undefined) return null;
  return (
    <li className="break-words">
      {label}{" "}
      <span className="text-text tabular">
        v{first.from}
        {steps.map((step) => (
          <span key={step.recordId}>
            {" "}
            <span aria-hidden="true">→</span>
            <span className="sr-only">to</span> v{step.to}
          </span>
        ))}
      </span>
    </li>
  );
}

function Lineage({ lineage }: { lineage: readonly MissionLineage[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-surface shadow-sm">
      <table className="w-full min-w-[40rem] text-left text-sm">
        <caption className="sr-only">Promoted prompt and playbook versions per mission</caption>
        <thead className="border-b border-border">
          <tr className="font-mono text-2xs tracking-label text-text-subtle uppercase">
            <th scope="col" className="px-4 py-3 font-normal">
              Mission
            </th>
            <th scope="col" className="px-4 py-3 font-normal">
              Steps
            </th>
            <th scope="col" className="px-4 py-3 font-normal">
              Lineage of promoted versions
            </th>
          </tr>
        </thead>
        <tbody>
          {lineage.map((entry) => (
            <tr key={entry.mission} className="border-b border-border align-top last:border-b-0">
              <th scope="row" className="px-4 py-3 font-medium">
                {entry.title}
              </th>
              <td className="px-4 py-3 font-mono text-xs text-text-muted tabular">
                {entry.steps === 0 ? "none" : `${entry.promoted} of ${entry.steps} promoted`}
              </td>
              <td className="px-4 py-3 font-mono text-xs text-text-muted">
                {entry.prompts.length + entry.playbooks.length === 0 ? (
                  <span className="text-text-subtle">
                    {entry.steps === 0
                      ? "not trained yet"
                      : "no candidate has beaten the shipped versions"}
                  </span>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {entry.prompts.map((chain) => (
                      <Chain key={chain.name} label={chain.name} steps={chain.steps} />
                    ))}
                    {entry.playbooks.map((chain) => (
                      <Chain
                        key={chain.key}
                        label={`house playbook ${chain.key}`}
                        steps={chain.steps}
                      />
                    ))}
                  </ul>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Training({
  rows,
  lineage,
}: {
  rows: readonly TrainingRow[];
  lineage: readonly MissionLineage[];
}) {
  if (rows.length === 0)
    return (
      <Empty title="No training round recorded">
        <p>
          <Code>pnpm train --mission all --rounds 1 --budget-minutes 60</Code> measures a baseline
          for each mission, asks the planner role for one prompt revision and one playbook revision,
          evaluates each on the same cases and keeps it only on a supported win with no regression.
          Every step writes a record to <Code>packages/evals/results/training/</Code>; none is
          committed yet. <Code>pnpm train --dry-run</Code> shows the plan without running anything.
        </p>
      </Empty>
    );
  return (
    <div className="flex flex-col gap-6">
      <Lineage lineage={lineage} />
      <ol className="flex flex-col gap-3">
        {rows.map((row) => (
          <Step key={row.id} row={row} />
        ))}
      </ol>
    </div>
  );
}
