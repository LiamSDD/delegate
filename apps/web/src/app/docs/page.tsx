import { ArrowUpRight } from "lucide-react";
import type { Metadata } from "next";

import { ArrivalPage } from "@/components/arrival-page";
import { repoFileUrl } from "@/lib/site";

export const metadata: Metadata = { title: "Docs" };

const EXISTING_DOCS = [
  {
    path: "docs/ARCHITECTURE.md",
    title: "Architecture",
    detail: "System overview, runtime pipeline, event stream",
  },
  {
    path: "docs/SECURITY.md",
    title: "Security",
    detail: "Threat model, trust boundaries, controls",
  },
  {
    path: "docs/adr/0001-hand-written-runtime.md",
    title: "ADR 0001",
    detail: "Hand-written agent runtime",
  },
  {
    path: "docs/adr/0002-quarantined-reader.md",
    title: "ADR 0002",
    detail: "Quarantined reader for untrusted content",
  },
  {
    path: "docs/adr/0003-zero-cost-model-routing.md",
    title: "ADR 0003",
    detail: "Zero-cost, keyless-first model routing",
  },
  { path: "SPEC.md", title: "Spec", detail: "Product and engineering spec, roadmap" },
] as const;

export default function DocsPage() {
  return (
    <ArrivalPage
      section="Docs"
      milestone="M8"
      title="Docs and the case study"
      summary="A browsable docs site and a case study on how Delegate was built with Claude Code land with the launch polish. The engineering documents already exist in the repository."
      willShow={[
        "Getting started: run a mission from the web, the CLI or Claude Code over MCP",
        "Architecture and security model, with diagrams",
        "Metrics table with real numbers from the evals",
        "How it was built with Claude Code, with real session numbers",
      ]}
    >
      <section aria-labelledby="available-now" className="flex flex-col gap-4">
        <h2
          id="available-now"
          className="font-mono text-2xs tracking-label text-text-subtle uppercase"
        >
          Available now on GitHub
        </h2>
        <ul className="border-b border-border">
          {EXISTING_DOCS.map((doc) => (
            <li key={doc.path} className="border-t border-border">
              <a
                href={repoFileUrl(doc.path)}
                target="_blank"
                rel="noreferrer"
                className="group flex flex-col gap-1 py-3.5 sm:flex-row sm:items-baseline sm:gap-6"
              >
                <span className="w-24 shrink-0 text-base font-medium text-text group-hover:text-accent">
                  {doc.title}
                </span>
                <span className="flex-1 text-sm text-text-muted">{doc.detail}</span>
                <span className="inline-flex items-center gap-1 font-mono text-xs text-text-subtle">
                  {doc.path}
                  <ArrowUpRight className="size-3" strokeWidth={1.5} aria-hidden="true" />
                </span>
              </a>
            </li>
          ))}
        </ul>
      </section>
    </ArrivalPage>
  );
}
