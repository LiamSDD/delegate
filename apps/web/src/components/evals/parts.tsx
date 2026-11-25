import type { ReactNode } from "react";

export const evalDateFormat = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

export function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-xs bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-text">
      {children}
    </code>
  );
}

export function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-border-strong px-5 py-6">
      <h3 className="text-base font-medium">{title}</h3>
      <div className="max-w-xl text-sm text-text-muted text-pretty">{children}</div>
    </div>
  );
}

export function Badge({
  tone,
  children,
}: {
  tone: "success" | "warning" | "neutral";
  children: ReactNode;
}) {
  const tones = {
    success: "bg-success-soft text-success",
    warning: "bg-warning-soft text-warning",
    neutral: "bg-surface-2 text-text-muted",
  } as const;
  return <span className={`rounded-sm px-1.5 font-mono text-2xs ${tones[tone]}`}>{children}</span>;
}
