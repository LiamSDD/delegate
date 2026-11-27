import { describe, expect, it } from "vitest";

import {
  createScheduler,
  currentSlice,
  functionBudgetMs,
  hasRoomForWork,
  HANDOFF_MARGIN_MS,
  VERCEL_FUNCTION_MAX_MS,
  withInvocation,
} from "./invocation";

function deferredRequest() {
  const kept: Promise<void>[] = [];
  const afterClose: (() => Promise<void>)[] = [];
  return {
    kept,
    afterClose,
    keepAlive: (work: Promise<void>) => {
      kept.push(work);
    },
    closeResponse: async () => {
      for (const callback of afterClose) await callback();
    },
  };
}

describe("createScheduler", () => {
  it("starts work at once instead of after the response closes, and keeps the function alive for it", async () => {
    const request = deferredRequest();
    const schedule = createScheduler({ keepAlive: request.keepAlive, budgetMs: () => 300_000 });
    const started: string[] = [];
    let finish: () => void = () => undefined;
    schedule(
      () =>
        new Promise<void>((resolve) => {
          started.push("child run");
          finish = resolve;
        }),
    );
    expect(started).toEqual(["child run"]);
    expect(request.kept).toHaveLength(1);
    let settled = false;
    void request.kept[0]?.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    await request.kept[0];
    expect(settled).toBe(true);
  });

  it("tracks work scheduled from scheduled work in the same invocation and keeps its start time", async () => {
    const request = deferredRequest();
    let clock = 1_000;
    const schedule = createScheduler({
      keepAlive: request.keepAlive,
      now: () => clock,
      budgetMs: () => 300_000,
    });
    const seen: (number | undefined)[] = [];
    schedule(async () => {
      seen.push(currentSlice()?.startedAt);
      clock = 200_000;
      await Promise.resolve();
      schedule(async () => {
        seen.push(currentSlice()?.startedAt);
        await new Promise((resolve) => setTimeout(resolve, 5));
        seen.push(-1);
      });
    });
    expect(request.kept).toHaveLength(1);
    await request.kept[0];
    expect(seen).toEqual([1_000, 1_000, -1]);
  });

  it("inherits the start of a long-lived stream so late work sees how little time is left", () => {
    const request = deferredRequest();
    const schedule = createScheduler({ keepAlive: request.keepAlive, budgetMs: () => 300_000 });
    const startedAt = Date.now() - 250_000;
    let room: boolean | undefined;
    withInvocation(
      () => {
        schedule(() => {
          room = hasRoomForWork(Date.now());
          return Promise.resolve();
        });
      },
      { startedAt, budgetMs: 300_000 },
    );
    expect(room).toBe(false);
    expect(hasRoomForWork(Date.now())).toBe(true);
  });

  it("swallows a keep-alive registration failure and still runs the work", async () => {
    let ran = false;
    const schedule = createScheduler({
      keepAlive: () => {
        throw new Error("outside a request scope");
      },
      budgetMs: () => null,
    });
    schedule(() => {
      ran = true;
      return Promise.resolve();
    });
    await Promise.resolve();
    expect(ran).toBe(true);
  });
});

describe("function budget", () => {
  it("applies the platform limit on Vercel, an explicit override, and nothing elsewhere", () => {
    expect(functionBudgetMs({ VERCEL: "1" })).toBe(VERCEL_FUNCTION_MAX_MS);
    expect(functionBudgetMs({ DELEGATE_FUNCTION_MAX_MS: "60000" })).toBe(60_000);
    expect(functionBudgetMs({})).toBeNull();
    const slice = withInvocation(() => currentSlice(), { startedAt: 0, budgetMs: 300_000 });
    expect(slice?.handoffAt).toBe(300_000 - HANDOFF_MARGIN_MS);
    expect(withInvocation(() => currentSlice(), { budgetMs: null })).toBeUndefined();
  });
});
