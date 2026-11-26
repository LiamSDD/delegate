import type { ReactNode } from "react";

export function SectionHeading({
  index,
  label,
  title,
  id,
  children,
}: {
  index: string;
  label: string;
  title: string;
  id: string;
  children?: ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:items-end md:gap-12">
      <div className="flex flex-col gap-3">
        <p className="font-mono text-2xs tracking-label text-text-subtle uppercase tabular">
          {index} <span aria-hidden="true">/</span> {label}
        </p>
        <h2 id={id} className="font-serif text-display-sm tracking-display text-balance">
          {title}
        </h2>
      </div>
      {children === undefined ? null : (
        <div className="max-w-md text-sm text-text-muted text-pretty md:justify-self-end">
          {children}
        </div>
      )}
    </div>
  );
}
