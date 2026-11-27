export interface RunLease {
  readonly ttlMs: number;
  acquire(): Promise<boolean>;
  renew(): Promise<boolean>;
  release(): Promise<void>;
}

export class LeaseLostError extends Error {
  override readonly name = "LeaseLostError";
  constructor() {
    super("Another worker took over this run's lease");
  }
}

export function createMemoryLeases(now: () => number = Date.now) {
  const holders = new Map<string, { owner: string; expiresAt: number }>();
  const claim = (runId: string, owner: string, ttlMs: number) => {
    const current = holders.get(runId);
    if (current !== undefined && current.owner !== owner && current.expiresAt > now()) return false;
    holders.set(runId, { owner, expiresAt: now() + ttlMs });
    return true;
  };
  return {
    holders,
    lease(runId: string, owner: string, ttlMs: number): RunLease {
      return {
        ttlMs,
        acquire: () => Promise.resolve(claim(runId, owner, ttlMs)),
        renew: () => Promise.resolve(claim(runId, owner, ttlMs)),
        release: () => {
          if (holders.get(runId)?.owner === owner) holders.delete(runId);
          return Promise.resolve();
        },
      };
    },
  };
}

export async function holdLease<T>(
  lease: RunLease,
  outer: AbortSignal | undefined,
  work: (signal: AbortSignal, held: () => boolean) => Promise<T>,
  now: () => number = Date.now,
): Promise<{ acquired: false } | { acquired: true; value: T; lost: boolean }> {
  const acquiredAt = now();
  if (!(await lease.acquire())) return { acquired: false };
  const controller = new AbortController();
  const signal =
    outer === undefined ? controller.signal : AbortSignal.any([outer, controller.signal]);
  const state = { lost: false, renewedAt: acquiredAt };
  const held = () => !state.lost && now() - state.renewedAt < lease.ttlMs;
  const lose = () => {
    if (state.lost) return;
    state.lost = true;
    controller.abort(new LeaseLostError());
  };
  const timer = setInterval(
    () => {
      if (state.lost) return;
      if (now() - state.renewedAt >= lease.ttlMs) {
        lose();
        return;
      }
      const issuedAt = now();
      lease.renew().then(
        (renewed) => {
          if (renewed) state.renewedAt = Math.max(state.renewedAt, issuedAt);
          else lose();
        },
        () => undefined,
      );
    },
    Math.max(1_000, Math.floor(lease.ttlMs / 3)),
  );
  timer.unref();
  try {
    const value = await work(signal, held);
    return { acquired: true, value, lost: state.lost };
  } finally {
    clearInterval(timer);
    if (!state.lost) await lease.release();
  }
}
