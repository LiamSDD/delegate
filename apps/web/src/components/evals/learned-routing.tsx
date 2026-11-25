import type { RoutingState } from "@/server/eval-results";

import { Badge, Code, Empty, evalDateFormat, pct } from "./parts";

function seconds(ms: number | null): string {
  return ms === null ? "no latency" : `trial p50 ${(ms / 1000).toFixed(1)} s`;
}

export function LearnedRoutingTable({ state }: { state: RoutingState }) {
  if (state.status !== "ok")
    return (
      <Empty
        title={state.status === "absent" ? "No learned routing yet" : "Learned routing unreadable"}
      >
        <p>
          {state.status === "absent"
            ? "Until this file exists the router uses the order written in config/models.json. "
            : "config/routing.learned.json does not match the learned-routing schema, so the router ignores it and uses the order in config/models.json. "}
          Run <Code>pnpm eval --mission all --trials 3</Code> so result files record which model
          served each trial, then <Code>pnpm route:learn</Code> to write{" "}
          <Code>config/routing.learned.json</Code>.
        </p>
      </Empty>
    );
  const { routing } = state;
  const learned = routing.entries.filter((entry) => entry.decision === "learned").length;
  return (
    <div className="flex flex-col gap-3">
      <p className="font-mono text-xs text-text-muted tabular">
        {learned} of {routing.entries.length} mission and role pairs learned ·{" "}
        {routing.source.trials} graded trials from {routing.source.resultFiles.length} result{" "}
        {routing.source.resultFiles.length === 1 ? "file" : "files"} · at least {routing.minTrials}{" "}
        trials per model ·{" "}
        <time dateTime={routing.generatedAt}>
          {evalDateFormat.format(new Date(routing.generatedAt))}
        </time>
      </p>
      {routing.entries.length === 0 ? (
        <Empty title="No mission has routing evidence">
          <p>
            The file lists no mission. Run <Code>pnpm eval --mission all --trials 3</Code>, then{" "}
            <Code>pnpm route:learn</Code>.
          </p>
        </Empty>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-surface shadow-sm">
          <table className="w-full min-w-[56rem] text-left text-sm">
            <caption className="sr-only">Learned model order per mission and role</caption>
            <thead className="border-b border-border">
              <tr className="font-mono text-2xs tracking-label text-text-subtle uppercase">
                <th scope="col" className="px-4 py-3 font-normal">
                  Mission and role
                </th>
                <th scope="col" className="px-4 py-3 font-normal">
                  Decision
                </th>
                <th scope="col" className="px-4 py-3 font-normal">
                  Models: trials, pass rate (95% CI)
                </th>
                <th scope="col" className="px-4 py-3 font-normal">
                  Why
                </th>
              </tr>
            </thead>
            <tbody>
              {routing.entries.map((entry) => (
                <tr
                  key={`${entry.mission}:${entry.role}`}
                  className="border-b border-border align-top last:border-b-0"
                >
                  <th scope="row" className="px-4 py-3 font-mono text-xs font-normal text-text">
                    {entry.mission}
                    <span className="block text-2xs text-text-subtle">{entry.role}</span>
                  </th>
                  <td className="px-4 py-3">
                    {entry.decision === "learned" ? (
                      <Badge tone="success">Learned order</Badge>
                    ) : (
                      <Badge tone="neutral">Insufficient evidence</Badge>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-text-muted">
                    {entry.order.length === 0 ? (
                      <span className="text-text-subtle">no attributed trial</span>
                    ) : (
                      <ol className="flex flex-col gap-1">
                        {entry.order.map((model, index) => (
                          <li key={`${model.provider}/${model.model}`} className="tabular">
                            <span className="text-text-subtle">
                              {entry.decision === "learned" ? `${index + 1}. ` : ""}
                            </span>
                            <span className="break-all text-text">
                              {model.provider}/{model.model}
                            </span>
                            <span className="block text-text-subtle">
                              n={model.trials} · {pct(model.passRate)} [{pct(model.ci[0])},{" "}
                              {pct(model.ci[1])}] · {seconds(model.p50LatencyMs)}
                            </span>
                          </li>
                        ))}
                      </ol>
                    )}
                  </td>
                  <td className="max-w-md px-4 py-3 text-sm text-text-muted text-pretty">
                    {entry.reason}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
