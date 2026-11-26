"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useTransition } from "react";

import { cn } from "@/lib/utils";

import { utcClock } from "./format";

export function AutoRefresh({
  renderedAt,
  intervalMs,
}: {
  renderedAt: string;
  intervalMs: number;
}) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible")
        startRefresh(() => {
          router.refresh();
        });
    };
    const timer = setInterval(refreshWhenVisible, intervalMs);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [router, intervalMs]);

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-2xs text-text-subtle">
      <p role="status">
        Read at{" "}
        <time dateTime={renderedAt} className="text-text-muted tabular">
          {utcClock.format(new Date(renderedAt))} UTC
        </time>{" "}
        <span aria-hidden="true">·</span> refreshes every {Math.round(intervalMs / 1000)} s while
        this tab is visible
      </p>
      <button
        type="button"
        disabled={refreshing}
        onClick={() => {
          startRefresh(() => {
            router.refresh();
          });
        }}
        className="inline-flex h-6 items-center gap-1.5 rounded-sm border border-border px-2 text-text-muted hover:border-border-strong hover:text-text disabled:opacity-60"
      >
        <RefreshCw
          className={cn("size-3", refreshing && "motion-safe:animate-spin")}
          aria-hidden="true"
        />
        {refreshing ? "Refreshing" : "Refresh now"}
      </button>
    </div>
  );
}
