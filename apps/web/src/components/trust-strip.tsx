import { ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";

import { MilestoneBadge } from "@/components/milestone-badge";
import {
  EvalsDiagram,
  EventLogDiagram,
  PolicyDiagram,
  QuarantineDiagram,
} from "@/components/trust-diagrams";
import { type MilestoneId } from "@/lib/roadmap";
import { repoFileUrl } from "@/lib/site";

interface TrustClaim {
  title: string;
  claim: string;
  mechanism: string;
  doc: { path: string; anchor?: string };
  arrives: MilestoneId;
  diagram: ReactNode;
}

const CLAIMS: readonly TrustClaim[] = [
  {
    title: "Quarantined reader",
    claim:
      "Web pages, uploads and connector data are read only by a tool-less model call that returns schema-checked fields. Agents with tools never see the raw text.",
    mechanism: "packages/runtime",
    doc: { path: "docs/adr/0002-quarantined-reader.md" },
    arrives: "M1",
    diagram: <QuarantineDiagram />,
  },
  {
    title: "Policy on every tool call",
    claim:
      "Capabilities, egress allowlists, spend caps and data classes are checked in code before a call runs. Allows and denials are both audited.",
    mechanism: "packages/policy",
    doc: { path: "docs/SECURITY.md", anchor: "controls" },
    arrives: "M4",
    diagram: <PolicyDiagram />,
  },
  {
    title: "Append-only event log",
    claim:
      "Plans, tool calls, policy decisions and approvals are typed events. The run view, traces, replay and forks are all rebuilt from them.",
    mechanism: "run_events",
    doc: { path: "docs/ARCHITECTURE.md", anchor: "event-stream" },
    arrives: "M4",
    diagram: <EventLogDiagram />,
  },
  {
    title: "Evals with confidence intervals",
    claim:
      "At least three trials per golden case, reported as mean ± 95% CI. A change that lowers quality or lets one attack through is rejected locally.",
    mechanism: "packages/evals",
    doc: { path: "SPEC.md", anchor: "reliability-and-evals" },
    arrives: "M4",
    diagram: <EvalsDiagram />,
  },
];

function docLabel(path: string): string {
  const file = path.split("/").at(-1) ?? path;
  const adr = /^(\d{4})-/.exec(file);
  return path.includes("/adr/") && adr ? `ADR ${adr[1] ?? ""}` : file;
}

export function TrustStrip() {
  return (
    <ol className="grid grid-cols-1 border-b border-border sm:grid-cols-2 lg:grid-cols-4">
      {CLAIMS.map((item, index) => {
        const href = `${repoFileUrl(item.doc.path)}${item.doc.anchor === undefined ? "" : `#${item.doc.anchor}`}`;
        return (
          <li
            key={item.title}
            className="flex flex-col gap-4 border-t border-border py-6 sm:pr-6 sm:even:border-l sm:even:pl-6 lg:not-first:border-l lg:not-first:pl-6"
          >
            <div className="flex items-center justify-between">
              <span className="font-mono text-xs text-text-subtle tabular">0{index + 1}</span>
              <MilestoneBadge id={item.arrives} />
            </div>
            {item.diagram}
            <div className="flex flex-col gap-2">
              <h3 className="text-base font-medium text-text">{item.title}</h3>
              <p className="text-sm text-text-muted text-pretty">{item.claim}</p>
            </div>
            <div className="mt-auto flex items-center justify-between gap-3 pt-2 font-mono text-xs">
              <span className="min-w-0 truncate text-text-subtle">{item.mechanism}</span>
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-text-muted underline-offset-4 transition-colors hover:text-accent hover:underline"
              >
                {docLabel(item.doc.path)}
                <ArrowUpRight className="size-3" strokeWidth={1.5} aria-hidden="true" />
                <span className="sr-only">(opens on GitHub)</span>
              </a>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
