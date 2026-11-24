import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-xs border border-border bg-surface-2 px-1 font-mono text-2xs text-text-muted",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
