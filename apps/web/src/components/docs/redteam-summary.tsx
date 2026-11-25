import { REDTEAM_RESULTS_PATH, type RedteamSummary } from "@/lib/docs/facts";
import { repoBlobUrl } from "@/lib/docs/links";

const generatedFormat = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

function percent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "ok" | "bad" }) {
  return (
    <div className="flex h-full flex-col justify-between gap-1.5 px-4 py-3.5">
      <dt className="font-mono text-2xs tracking-label text-text-subtle uppercase">{label}</dt>
      <dd
        className={`font-serif text-display-sm leading-none tabular ${
          tone === "ok" ? "text-success" : tone === "bad" ? "text-danger" : "text-text"
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

export function RedteamSummaryPanel({ summary }: { summary: RedteamSummary | null }) {
  if (summary === null)
    return (
      <p
        role="note"
        className="mt-5 rounded-lg border border-warning/40 bg-warning-soft px-4 py-3 text-sm text-warning"
      >
        The red-team result file ({REDTEAM_RESULTS_PATH}) is missing or does not match the expected
        format on this deployment, so no numbers are shown. Run pnpm redteam to write it.
      </p>
    );
  const blocked = summary.successes === 0;
  return (
    <section
      aria-label="Current red-team result"
      className="mt-5 overflow-hidden rounded-lg border border-border bg-surface"
    >
      <dl className="grid grid-cols-2 divide-x divide-y divide-border border-b border-border sm:grid-cols-4 sm:divide-y-0">
        <Stat label="Attack cases" value={String(summary.attacks)} />
        <Stat label="Categories" value={String(summary.byCategory.length)} />
        <Stat label="Succeeded" value={String(summary.successes)} tone={blocked ? "ok" : "bad"} />
        <Stat
          label="Attack success rate"
          value={percent(summary.asr)}
          tone={blocked ? "ok" : "bad"}
        />
      </dl>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className="px-4 py-2 text-left font-medium text-text">
              Category
            </th>
            <th scope="col" className="px-4 py-2 text-right font-medium text-text">
              Cases
            </th>
            <th scope="col" className="px-4 py-2 text-right font-medium text-text">
              Succeeded
            </th>
          </tr>
        </thead>
        <tbody>
          {summary.byCategory.map((row) => (
            <tr key={row.category} className="border-b border-border last:border-b-0">
              <td className="px-4 py-2 font-mono text-xs text-text">{row.category}</td>
              <td className="px-4 py-2 text-right text-text tabular">{row.attacks}</td>
              <td
                className={`px-4 py-2 text-right tabular ${
                  row.successes === 0 ? "text-text-muted" : "text-danger"
                }`}
              >
                {row.successes}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-border bg-surface-2 px-4 py-2.5 font-mono text-2xs text-text-muted">
        Read from{" "}
        <a
          href={repoBlobUrl(REDTEAM_RESULTS_PATH)}
          target="_blank"
          rel="noreferrer"
          className="text-text underline decoration-border-strong underline-offset-[3px] hover:text-accent"
        >
          {REDTEAM_RESULTS_PATH}
        </a>{" "}
        as shipped with this deployment · suite {summary.suite} · written by pnpm redteam on{" "}
        <time dateTime={summary.generatedAt}>
          {generatedFormat.format(new Date(summary.generatedAt))} UTC
        </time>
      </p>
    </section>
  );
}
