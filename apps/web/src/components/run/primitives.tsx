"use client";

import { useEffect, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("font-mono text-2xs tracking-label text-text-subtle uppercase", className)}>
      {children}
    </span>
  );
}

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

const TONES: Record<Tone, string> = {
  neutral: "border-border bg-surface-2 text-text-muted",
  accent: "border-transparent bg-accent-soft text-accent",
  success: "border-transparent bg-success-soft text-success",
  warning: "border-transparent bg-warning-soft text-warning",
  danger: "border-transparent bg-danger-soft text-danger",
};

export function Chip({
  tone = "neutral",
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 max-w-full items-center gap-1 rounded-sm border px-1.5 font-mono text-2xs whitespace-nowrap tabular",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return () => {
      clearInterval(timer);
    };
  }, [active, intervalMs]);
  return now;
}

export const actionButton =
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md border border-border bg-surface px-3 text-sm font-medium text-text shadow-sm transition-colors hover:border-border-strong disabled:cursor-not-allowed disabled:opacity-60";

export const primaryButton =
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-fg transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60";
