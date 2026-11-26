import { WEBHOOK_TEST_EVENT_TYPE } from "@delegate/sdk/contract";

export const MAX_WEBHOOK_ENDPOINTS = 5;
export const WEBHOOK_MAX_ATTEMPTS = 6;
export const WEBHOOK_TEST_MAX_ATTEMPTS = 1;
export const WEBHOOK_RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 3_600_000,
  8 * 3_600_000,
] as const;
export const WEBHOOK_RETRY_AFTER_CEILING_MS = 24 * 3_600_000;
export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_LEASE_SECONDS = 60;
export const WEBHOOK_BATCH_SIZE = 10;
export const WEBHOOK_FLUSH_THROTTLE_MS = 30_000;
export const WEBHOOK_TESTS_PER_MINUTE = 10;

export type RetryPlan = { outcome: "retry"; nextAttemptAt: Date } | { outcome: "failed" };

export function maxAttemptsFor(eventType: string): number {
  return eventType === WEBHOOK_TEST_EVENT_TYPE ? WEBHOOK_TEST_MAX_ATTEMPTS : WEBHOOK_MAX_ATTEMPTS;
}

export function retryDelayMs(attemptsMade: number): number {
  const index = Math.min(Math.max(attemptsMade, 1), WEBHOOK_RETRY_DELAYS_MS.length) - 1;
  return WEBHOOK_RETRY_DELAYS_MS[index] ?? WEBHOOK_RETRY_DELAYS_MS[0];
}

export function planRetry(input: {
  attemptsMade: number;
  maxAttempts: number;
  now: Date;
  retryAfterMs?: number | null;
}): RetryPlan {
  if (input.attemptsMade >= input.maxAttempts) return { outcome: "failed" };
  const requested = Math.max(0, input.retryAfterMs ?? 0);
  const delay = Math.min(
    WEBHOOK_RETRY_AFTER_CEILING_MS,
    Math.max(retryDelayMs(input.attemptsMade), requested),
  );
  return { outcome: "retry", nextAttemptAt: new Date(input.now.getTime() + delay) };
}
