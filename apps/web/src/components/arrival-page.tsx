import Link from "next/link";
import type { ReactNode } from "react";

import { RoadmapRail } from "@/components/roadmap-rail";
import { type MilestoneId, milestoneById } from "@/lib/roadmap";

export interface ArrivalPageProps {
  section: string;
  milestone: MilestoneId;
  title: string;
  summary: string;
  willShow: readonly string[];
  children?: ReactNode;
}

export function ArrivalPage({
  section,
  milestone,
  title,
  summary,
  willShow,
  children,
}: ArrivalPageProps) {
  const target = milestoneById(milestone);
  return (
    <div className="mx-auto grid max-w-content gap-16 px-6 pt-16 pb-24 md:pt-24 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-24">
      <div className="flex flex-col gap-12">
        <header className="flex flex-col gap-5">
          <p className="font-mono text-2xs tracking-label text-text-subtle uppercase">
            {section} <span aria-hidden="true">·</span> arrives in{" "}
            <span className="text-accent">{target.id}</span> <span aria-hidden="true">·</span>{" "}
            {target.title}
          </p>
          <h1 className="font-serif text-display-md tracking-display text-balance">{title}</h1>
          <p className="max-w-xl text-md text-text-muted text-pretty">{summary}</p>
        </header>
        <section aria-labelledby="will-show" className="flex flex-col gap-4">
          <h2
            id="will-show"
            className="font-mono text-2xs tracking-label text-text-subtle uppercase"
          >
            What this page will show
          </h2>
          <ol className="border-b border-border">
            {willShow.map((item, index) => (
              <li key={item} className="flex gap-5 border-t border-border py-3.5 text-base">
                <span className="w-6 shrink-0 pt-px font-mono text-xs leading-6 text-text-subtle tabular">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="text-text">{item}</span>
              </li>
            ))}
          </ol>
        </section>
        {children}
        <p className="text-sm text-text-muted">
          Nothing on this page is simulated. Until {target.id} ships it stays empty rather than
          showing sample data.{" "}
          <Link href="/" className="text-text underline underline-offset-4 hover:text-accent">
            Back to home
          </Link>
        </p>
      </div>
      <aside className="lg:pt-2">
        <RoadmapRail target={milestone} />
      </aside>
    </div>
  );
}
