"use client";

import { useSyncExternalStore } from "react";

import { formatAgo, formatSpan } from "./format";

const TICK_MS = 1000;

function subscribe(onTick: () => void): () => void {
  const timer = setInterval(onTick, TICK_MS);
  return () => {
    clearInterval(timer);
  };
}

function wallClock(): number {
  return Math.floor(Date.now() / TICK_MS) * TICK_MS;
}

export function useClock(renderedAt: number): number {
  return useSyncExternalStore(subscribe, wallClock, () => renderedAt);
}

export function Elapsed({ since, renderedAt }: { since: string; renderedAt: number }) {
  const now = useClock(renderedAt);
  return <span className="tabular">{formatSpan(now - Date.parse(since))}</span>;
}

export function Ago({ at, renderedAt }: { at: string; renderedAt: number }) {
  const now = useClock(renderedAt);
  return <span className="tabular">{formatAgo(now - Date.parse(at))}</span>;
}
