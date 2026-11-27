import { AsyncLocalStorage } from "node:async_hooks";

export const VERCEL_FUNCTION_MAX_MS = 300_000;
export const HANDOFF_MARGIN_MS = 25_000;
export const MIN_SLICE_MS = 90_000;

interface Invocation {
  startedAt: number;
  budgetMs: number | null;
  pending?: Set<Promise<void>>;
}

export interface Slice {
  startedAt: number;
  budgetMs: number;
  handoffAt: number;
  minMs?: number;
}

const store = new AsyncLocalStorage<Invocation>();

export function functionBudgetMs(
  env: Record<string, string | undefined> = process.env,
): number | null {
  const configured = Number(env.DELEGATE_FUNCTION_MAX_MS);
  if (Number.isInteger(configured) && configured > 0) return configured;
  return env.VERCEL === "1" ? VERCEL_FUNCTION_MAX_MS : null;
}

export function withInvocation<T>(
  fn: () => T,
  options: { startedAt?: number; budgetMs?: number | null } = {},
): T {
  if (store.getStore() !== undefined) return fn();
  return store.run(
    {
      startedAt: options.startedAt ?? Date.now(),
      budgetMs: options.budgetMs === undefined ? functionBudgetMs() : options.budgetMs,
    },
    fn,
  );
}

export function currentSlice(): Slice | undefined {
  const invocation = store.getStore();
  if (invocation === undefined || invocation.budgetMs === null) return undefined;
  return {
    startedAt: invocation.startedAt,
    budgetMs: invocation.budgetMs,
    handoffAt: invocation.startedAt + invocation.budgetMs - HANDOFF_MARGIN_MS,
  };
}

export function sliceLeftMs(now: number, slice: Slice | undefined = currentSlice()): number {
  return slice === undefined ? Number.POSITIVE_INFINITY : slice.handoffAt - now;
}

export function hasRoomForWork(now: number, slice: Slice | undefined = currentSlice()): boolean {
  return sliceLeftMs(now, slice) >= (slice?.minMs ?? MIN_SLICE_MS);
}

async function settle(invocation: Invocation): Promise<void> {
  const pending = invocation.pending ?? new Set();
  while (pending.size > 0) await Promise.allSettled([...pending]);
}

function track(invocation: Invocation, task: () => Promise<void>): void {
  const pending = invocation.pending ?? new Set();
  invocation.pending = pending;
  const running: Promise<void> = task()
    .catch((error: unknown) => {
      console.error("scheduled task failed", error instanceof Error ? error.message : "unknown");
    })
    .finally(() => {
      pending.delete(running);
    });
  pending.add(running);
}

export interface SchedulerOptions {
  keepAlive: (work: Promise<void>) => void;
  now?: () => number;
  budgetMs?: () => number | null;
}

export function createScheduler(options: SchedulerOptions): (task: () => Promise<void>) => void {
  const now = options.now ?? Date.now;
  const budget = options.budgetMs ?? (() => functionBudgetMs());
  return (task) => {
    const current = store.getStore();
    if (current?.pending !== undefined) {
      track(current, task);
      return;
    }
    const invocation: Invocation = {
      startedAt: current?.startedAt ?? now(),
      budgetMs: current === undefined ? budget() : current.budgetMs,
      pending: new Set(),
    };
    store.run(invocation, () => {
      track(invocation, task);
    });
    try {
      options.keepAlive(settle(invocation));
    } catch (error: unknown) {
      console.error(
        "keep-alive registration failed",
        error instanceof Error ? error.message : "unknown",
      );
    }
  };
}
