import { RATE_LIMIT_HEADERS } from "@delegate/sdk/contract";

export const V1_REQUESTS_PER_HOUR = 1_200;
const WINDOW_ENTRIES_CEILING = 10_000;

export interface RequestBudget {
  ok: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
}

export interface RequestLimiter {
  take(key: string): RequestBudget;
}

export function createRequestLimiter(options: {
  limit: number;
  windowMs: number;
  now?: () => number;
}): RequestLimiter {
  const now = options.now ?? Date.now;
  const windows = new Map<string, { startedAt: number; used: number }>();
  return {
    take(key) {
      const at = now();
      let window = windows.get(key);
      if (window === undefined || at - window.startedAt >= options.windowMs) {
        if (windows.size >= WINDOW_ENTRIES_CEILING)
          for (const [stale, entry] of windows)
            if (at - entry.startedAt >= options.windowMs) windows.delete(stale);
        window = { startedAt: at, used: 0 };
        windows.set(key, window);
      }
      const resetSeconds = Math.max(
        1,
        Math.ceil((window.startedAt + options.windowMs - at) / 1000),
      );
      if (window.used >= options.limit)
        return { ok: false, limit: options.limit, remaining: 0, resetSeconds };
      window.used += 1;
      return {
        ok: true,
        limit: options.limit,
        remaining: options.limit - window.used,
        resetSeconds,
      };
    },
  };
}

export function rateLimitHeaders(budget: RequestBudget): Record<string, string> {
  return {
    [RATE_LIMIT_HEADERS.limit]: String(budget.limit),
    [RATE_LIMIT_HEADERS.remaining]: String(budget.remaining),
    [RATE_LIMIT_HEADERS.reset]: String(budget.resetSeconds),
  };
}

const holder = globalThis as typeof globalThis & { __delegateV1Limiter?: RequestLimiter };

export function v1RequestLimiter(): RequestLimiter {
  holder.__delegateV1Limiter ??= createRequestLimiter({
    limit: V1_REQUESTS_PER_HOUR,
    windowMs: 60 * 60 * 1000,
  });
  return holder.__delegateV1Limiter;
}
