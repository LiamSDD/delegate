import { describe, expect, it } from "vitest";

import { Budget, BudgetExceededError } from "../budget";
import { parseModelsConfig } from "../models";
import { RateLimitedError } from "../providers/types";
import { NoModelAvailableError } from "../router";
import { scriptedProvider, testRun, textTurn, TEST_USAGE } from "../testing/fakes";
import { createRunContext } from "./context";
import { createRunEmitter } from "./emitter";
import { callModel } from "./model-call";

const request = {
  system: "You are terse.",
  messages: [{ role: "user" as const, content: "Say hi" }],
  maxTokens: 100,
};

describe("callModel", () => {
  it("collects text, keeps reasoning private and emits usage with cached tokens", async () => {
    const provider = scriptedProvider("fake", [textTurn("Hello there")]);
    const { ctx, events } = testRun({ provider });
    const seen: string[] = [];
    const result = await callModel(ctx, {
      role: "worker",
      stepId: "s1",
      request,
      onText: (text) => seen.push(text),
    });
    expect(result).toMatchObject({
      text: "Hello there",
      reasoning: "private chain of thought",
      stopReason: "end",
      provider: "fake",
      model: "fake-worker",
    });
    expect(seen.join("")).toBe("Hello there");
    expect(seen.join("")).not.toContain("chain of thought");
    expect(events).toEqual([
      {
        runId: "run_1",
        type: "usage.updated",
        stepId: "s1",
        payload: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 40,
          cacheWriteTokens: 0,
          costMicroUsd: 0,
          provider: "fake",
          model: "fake-worker",
        },
      },
    ]);
    expect(ctx.budget.spent("s1").tokens).toBe(160);
  });

  it("emits usage before raising a budget overrun", async () => {
    const provider = scriptedProvider("fake", [textTurn("x")]);
    const { ctx, events } = testRun({ provider, maxTokens: 50 });
    await expect(callModel(ctx, { role: "worker", stepId: "s1", request })).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    expect(events.map((event) => event.type)).toEqual(["usage.updated"]);
  });

  it("waits out a rate limit when every model is throttled, then retries", async () => {
    let calls = 0;
    const provider = {
      id: "fake",
      async *stream() {
        calls += 1;
        await Promise.resolve();
        if (calls === 1) throw new RateLimitedError("fake", 2000);
        yield* textTurn("ok");
      },
    };
    let clock = 0;
    const run = testRun({ provider, clock: () => clock });
    const sleeps: number[] = [];
    run.ctx.sleep = (ms) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    };
    const result = await callModel(run.ctx, { role: "worker", stepId: "s1", request });
    expect(result.text).toBe("ok");
    expect(sleeps.length).toBe(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(2000);
    expect(run.events.map((event) => event.type)).toEqual(["model.fallback", "usage.updated"]);
  });

  it("backs off when a rate limit carries no retry-after", async () => {
    let calls = 0;
    const provider = {
      id: "fake",
      async *stream() {
        calls += 1;
        await Promise.resolve();
        if (calls <= 2) throw new RateLimitedError("fake");
        yield* textTurn("ok");
      },
    };
    let clock = 0;
    const run = testRun({ provider, clock: () => clock });
    const sleeps: number[] = [];
    run.ctx.sleep = (ms) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    };
    const result = await callModel(run.ctx, { role: "worker", stepId: "s1", request });
    expect(result.text).toBe("ok");
    expect(sleeps).toHaveLength(2);
    expect(sleeps[1]).toBeGreaterThan(sleeps[0] ?? 0);
  });

  it("gives up when the rate-limit wait exceeds the patience budget", async () => {
    const provider = {
      id: "fake",
      // eslint-disable-next-line require-yield
      async *stream() {
        await Promise.resolve();
        throw new RateLimitedError("fake", 120_000);
      },
    };
    const { ctx } = testRun({ provider });
    await expect(
      callModel(ctx, { role: "worker", stepId: "s1", request, maxRateLimitWaitMs: 30_000 }),
    ).rejects.toBeInstanceOf(NoModelAvailableError);
  });

  it("prices BYOK models from config", async () => {
    const config = parseModelsConfig({
      version: 1,
      providers: [
        {
          id: "fake",
          kind: "anthropic",
          apiKeyEnv: "FAKE_KEY",
          keyless: false,
          terms: "byok",
          maxClassification: "public",
          dataPolicy: "test",
          pricing: {
            m: {
              inputUsdPerMTok: 1,
              outputUsdPerMTok: 10,
              cacheReadUsdPerMTok: 0.1,
              cacheWriteUsdPerMTok: 1,
            },
          },
        },
      ],
      roles: {
        planner: [{ provider: "fake", model: "m", contextWindow: 10000, supportsTools: true }],
        worker: [{ provider: "fake", model: "m", contextWindow: 10000, supportsTools: true }],
        fast: [{ provider: "fake", model: "m", contextWindow: 10000, supportsTools: true }],
      },
    });
    const provider = scriptedProvider("fake", [textTurn("x", TEST_USAGE)]);
    const ctx = createRunContext({
      runId: "run_1",
      workspaceId: "ws_1",
      audience: "owner",
      classification: "public",
      config,
      env: { FAKE_KEY: "k" },
      emitter: createRunEmitter(() => Promise.resolve()),
      budget: new Budget({ run: { maxTokens: 10_000, maxMicroUsd: 1_000_000 } }),
      policies: [],
      createProvider: () => provider,
    });
    const result = await callModel(ctx, { role: "worker", stepId: "s1", request });
    expect(result.usage.costMicroUsd).toBe(100 * 1 + 20 * 10 + Math.ceil(40 * 0.1));
  });
});
