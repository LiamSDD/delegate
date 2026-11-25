import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export function ControlSection({
  id,
  index,
  label,
  title,
  aside,
  children,
}: {
  id: string;
  index: string;
  label: string;
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="flex scroll-mt-28 flex-col gap-5 border-t border-border pt-8"
    >
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 flex-col gap-2">
          <p className="font-mono text-2xs tracking-label text-text-subtle uppercase tabular">
            {index} <span aria-hidden="true">/</span> {label}
          </p>
          <h2 id={id} className="text-lg font-medium text-balance text-text">
            {title}
          </h2>
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function EmptyState({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-empty-state=""
      className={cn(
        "flex flex-col gap-1.5 rounded-xl border border-dashed border-border-strong px-5 py-6",
        className,
      )}
    >
      <p className="text-sm font-medium text-text">{title}</p>
      <div className="max-w-2xl text-sm text-text-muted text-pretty">{children}</div>
    </div>
  );
}

export function Fact({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5", className)}>
      <dt className="font-mono text-2xs tracking-label text-text-subtle uppercase">{label}</dt>
      <dd className="min-w-0 font-mono text-sm break-words text-text tabular">{children}</dd>
    </div>
  );
}

export const textLink =
  "text-text underline decoration-border-strong underline-offset-4 hover:text-accent hover:decoration-accent";
