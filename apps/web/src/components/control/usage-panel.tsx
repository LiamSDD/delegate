import type { ReactNode } from "react";

import { missionLabel } from "@/lib/m2-contract";
import { cn } from "@/lib/utils";
import { VERCEL_SANDBOX_HOBBY, type WorkspaceUsage } from "@/server/control/usage";

import { formatCount, formatHours, formatSeconds, plural, utcDate, utcDateTime } from "./format";
import { textLink } from "./section";

function Tile({
  label,
  window,
  children,
  className,
}: {
  label: string;
  window: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-usage={label}
      className={cn("flex min-w-0 flex-col gap-3 bg-surface px-4 py-4", className)}
    >
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-medium text-text">{label}</h3>
        <p className="font-mono text-2xs tracking-label text-text-subtle uppercase">{window}</p>
      </div>
      {children}
    </div>
  );
}

function Figure({ value, unit }: { value: string; unit: string }) {
  return (
    <p className="flex flex-wrap items-baseline gap-x-2">
      <span className="font-mono text-xl text-text tabular">{value}</span>
      <span className="text-sm text-text-muted">{unit}</span>
    </p>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="text-sm text-text-muted text-pretty">{children}</p>;
}

function QuotaMeter({ used, limit }: { used: number; limit: number }) {
  const share = limit === 0 ? 0 : Math.min(1, used / limit);
  return (
    <div
      role="meter"
      aria-label="Runs started in the last 60 minutes against the guest quota"
      aria-valuemin={0}
      aria-valuemax={limit}
      aria-valuenow={Math.min(used, limit)}
      aria-valuetext={`${String(used)} of ${String(limit)} runs`}
      className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2"
    >
      <div
        className={cn("h-full rounded-full", used >= limit ? "bg-warning" : "bg-accent")}
        style={{ width: `${String(Math.round(share * 100))}%` }}
      />
    </div>
  );
}

function MissionTokens({ usage }: { usage: WorkspaceUsage }) {
  if (usage.missions.length === 0)
    return (
      <Note>
        No run started in the last {usage.windowDays} days. Each mission that runs gets a row here
        with its run count and the input and output tokens its model calls reported.
      </Note>
    );
  return (
    <div className="-mx-4 overflow-x-auto px-4">
      <table className="w-full min-w-0 border-collapse text-left text-sm">
        <thead>
          <tr className="font-mono text-2xs tracking-label text-text-subtle uppercase">
            <th scope="col" className="py-1.5 pr-3 font-normal">
              Mission
            </th>
            <th scope="col" className="py-1.5 pr-3 text-right font-normal">
              Runs
            </th>
            <th scope="col" className="py-1.5 pr-3 text-right font-normal">
              Tokens in
            </th>
            <th scope="col" className="py-1.5 text-right font-normal">
              Tokens out
            </th>
          </tr>
        </thead>
        <tbody>
          {usage.missions.map((row) => (
            <tr key={row.mission} className="border-t border-border">
              <th scope="row" className="py-2 pr-3 font-normal break-words text-text">
                {missionLabel(row.mission)}
              </th>
              <td className="py-2 pr-3 text-right font-mono text-text tabular">
                {formatCount(row.runs)}
              </td>
              <td className="py-2 pr-3 text-right font-mono text-text tabular">
                {formatCount(row.inputTokens)}
              </td>
              <td className="py-2 text-right font-mono text-text tabular">
                {formatCount(row.outputTokens)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function UsagePanel({ usage }: { usage: WorkspaceUsage }) {
  const window = `Last ${String(usage.windowDays)} days, since ${utcDate.format(usage.since)}`;
  const { quota, fallbacks, sandbox, crawl } = usage;
  const totalTokens = usage.missions.reduce(
    (sum, row) => sum + row.inputTokens + row.outputTokens,
    0,
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-px overflow-hidden rounded-xl border border-border bg-border shadow-sm md:grid-cols-2">
        <Tile label="Runs against the guest quota" window="Last 60 minutes, and today (UTC)">
          <Figure
            value={`${formatCount(quota.lastHour)} of ${formatCount(quota.limitPerHour)}`}
            unit="runs started in the last 60 minutes"
          />
          <QuotaMeter used={quota.lastHour} limit={quota.limitPerHour} />
          <Note>
            A guest may start {quota.limitPerHour} runs an hour. {plural(quota.today, "run")}{" "}
            started today, since {utcDateTime.format(quota.dayStart)} UTC.{" "}
            {quota.lastHour === 0 && quota.today === 0
              ? "Runs you start are counted here from the run log."
              : "Counted from the run log; an Autopilot run counts through the steps it starts."}
          </Note>
        </Tile>

        <Tile label="Tokens by mission" window={window}>
          {usage.missions.length === 0 ? null : (
            <Figure value={formatCount(totalTokens)} unit="tokens, input plus output" />
          )}
          <MissionTokens usage={usage} />
        </Tile>

        <Tile label="Model fallbacks" window={window}>
          <Figure
            value={formatCount(fallbacks.total)}
            unit="times a model call moved down the chain"
          />
          {fallbacks.total === 0 ? (
            <Note>
              None recorded. When a provider is rate limited, times out or returns something
              unusable, the run falls back to the next model and the reason is counted here.
            </Note>
          ) : (
            <>
              <ul className="flex flex-col gap-1">
                {fallbacks.byReason.map((row) => (
                  <li
                    key={row.reason}
                    className="flex items-baseline justify-between gap-4 border-t border-border pt-1 text-sm"
                  >
                    <span className="min-w-0 font-mono break-all text-text-muted">
                      {row.reason}
                    </span>
                    <span className="shrink-0 font-mono text-text tabular">
                      {formatCount(row.count)}
                    </span>
                  </li>
                ))}
              </ul>
              <Note>
                {fallbacks.exhausted === 0
                  ? "Every one found another model to continue with."
                  : `${formatCount(fallbacks.exhausted)} of them had no model left to fall back to.`}
              </Note>
            </>
          )}
        </Tile>

        <Tile label="Sandbox command time" window={window}>
          <Figure
            value={formatSeconds(sandbox.seconds)}
            unit={`wall-clock, across ${plural(sandbox.commands, "sandbox command")}`}
          />
          <Note>
            {sandbox.commands === 0
              ? "No sandbox command has run. Missions that execute code (Repo X-ray tests, Ship-a-PR) log each command with its duration, and the durations are summed here. "
              : null}
            Free-tier allowance: {VERCEL_SANDBOX_HOBBY.activeCpuHoursPerMonth} hours of Active CPU a
            month on Vercel Hobby (
            <a href={VERCEL_SANDBOX_HOBBY.source} rel="noreferrer" className={textLink}>
              Vercel Sandbox pricing
            </a>
            , checked {VERCEL_SANDBOX_HOBBY.checkedOn}). Wall-clock command time is not Active CPU
            {sandbox.commands === 0
              ? "."
              : `: ${formatHours(sandbox.seconds)} logged here is an upper bound on what these commands used, not a balance.`}
          </Note>
        </Tile>

        <Tile label="Crawl pages fetched" window={window} className="md:col-span-2">
          <Figure value={formatCount(crawl.pages)} unit="pages fetched by crawl tools" />
          <Note>
            {crawl.pages === 0 && crawl.siteCrawls === 0
              ? "No page has been crawled. Each successful page fetch and each site crawl a run makes is counted here from its tool results."
              : `Single page fetches plus the pages of ${plural(crawl.siteCrawls, "site crawl")}, counted from successful tool results.`}
            {crawl.uncountedCrawls === 0
              ? ""
              : ` ${plural(crawl.uncountedCrawls, "site crawl")} did not report a page count and ${crawl.uncountedCrawls === 1 ? "is" : "are"} not in this figure.`}
          </Note>
        </Tile>
      </div>
      <p className="text-sm text-text-subtle">
        Every figure is summed from this workspace&apos;s run log at {utcDateTime.format(usage.now)}{" "}
        UTC. Nothing here is estimated.
      </p>
    </div>
  );
}
