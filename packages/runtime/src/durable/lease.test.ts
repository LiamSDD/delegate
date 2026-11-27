import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { holdLease, LeaseLostError, type RunLease } from "./lease";

function flakyLease(results: ("ok" | "error" | "taken")[]): RunLease & { renewals: number } {
  const lease = {
    ttlMs: 30_000,
    renewals: 0,
    acquire: () => Promise.resolve(true),
    renew: () => {
      const result = results[lease.renewals] ?? "ok";
      lease.renewals += 1;
      if (result === "error") return Promise.reject(new Error("connection reset"));
      return Promise.resolve(result === "ok");
    },
    release: () => Promise.resolve(),
  };
  return lease;
}

describe("holdLease", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function runFor(lease: RunLease, ms: number) {
    let aborted: unknown;
    const held = holdLease(
      lease,
      undefined,
      (signal) =>
        new Promise<string>((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = signal.reason;
            resolve("aborted");
          });
          setTimeout(() => {
            resolve("done");
          }, ms);
        }),
      () => Date.now(),
    );
    await vi.advanceTimersByTimeAsync(ms);
    return { result: await held, aborted };
  }

  it("keeps working through one failed renewal", async () => {
    const lease = flakyLease(["ok", "error", "ok", "ok"]);
    const { result, aborted } = await runFor(lease, 45_000);
    expect(result).toMatchObject({ acquired: true, value: "done", lost: false });
    expect(aborted).toBeUndefined();
  });

  it("gives up after renewals keep failing, before the lease can expire", async () => {
    const lease = flakyLease(["error", "error", "error"]);
    const { result, aborted } = await runFor(lease, 45_000);
    expect(result).toMatchObject({ acquired: true, value: "aborted", lost: true });
    expect(aborted).toBeInstanceOf(LeaseLostError);
    expect(lease.renewals).toBe(2);
  });

  it("stops at once when another worker took the lease", async () => {
    const lease = flakyLease(["taken"]);
    const { result } = await runFor(lease, 45_000);
    expect(result).toMatchObject({ value: "aborted", lost: true });
  });
});
