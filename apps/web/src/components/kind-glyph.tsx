import type { ReactNode } from "react";

import type { DetectedKind } from "@/lib/detect-mission";
import { cn } from "@/lib/utils";

const SHAPES: Record<DetectedKind, ReactNode> = {
  company: (
    <>
      <path d="M2.5 13.5h11M4 13.5v-9h5v9M9 7.5h3v6" />
      <path d="M6 7h1M6 10h1" />
    </>
  ),
  repo: (
    <>
      <circle cx="5" cy="3.75" r="1.5" />
      <circle cx="5" cy="12.25" r="1.5" />
      <circle cx="11" cy="5.25" r="1.5" />
      <path d="M5 5.25v5.5M11 6.75c0 2.5-6 1.75-6 4" />
    </>
  ),
  goal: <path d="M3 4.5h10M3 8h10M3 11.5h6" />,
};

export function KindGlyph({ kind, className }: { kind: DetectedKind; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={cn("size-3.5 shrink-0 text-text-muted", className)}
    >
      {SHAPES[kind]}
    </svg>
  );
}
