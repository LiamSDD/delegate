import Link from "next/link";

import type { DocEntry } from "@/lib/docs/registry";

export function AdrIndex({ adrs }: { adrs: readonly DocEntry[] }) {
  if (adrs.length === 0)
    return (
      <p role="note" className="mt-5 text-sm text-text-muted">
        No decision records were found in docs/adr on this deployment.
      </p>
    );
  return (
    <ol
      aria-label={`${adrs.length} architecture decision records`}
      className="mt-6 border-b border-border"
    >
      {adrs.map((entry) => {
        const meta = [entry.adr?.status, entry.adr?.date].filter(
          (part): part is string => typeof part === "string",
        );
        return (
          <li key={entry.route} className="border-t border-border">
            <Link
              href={entry.route}
              className="group grid grid-cols-[3rem_minmax(0,1fr)] gap-x-3 gap-y-1 py-3.5"
            >
              <span className="pt-0.5 font-mono text-xs leading-5 text-text-subtle tabular">
                {entry.adr?.number}
              </span>
              <span className="text-base text-text underline decoration-transparent underline-offset-[3px] transition-colors group-hover:text-accent group-hover:decoration-accent/40">
                {entry.adr?.title ?? entry.label}
              </span>
              {meta.length === 0 ? null : (
                <span className="col-start-2 font-mono text-2xs leading-4 text-text-subtle">
                  {meta.join(" · ")}
                </span>
              )}
            </Link>
          </li>
        );
      })}
    </ol>
  );
}
