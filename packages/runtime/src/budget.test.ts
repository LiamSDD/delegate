import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { Budget, BudgetExceededError, UnknownPriceError, costMicroUsd, priceFor } from "./budget";
import { type Usage } from "./events";
import { parseModelsConfig } from "./models";

const config = parseModelsConfig(
  JSON.parse(readFileSync(new URL("../../../config/models.json", import.meta.url), "utf8")),
);

function usage(partial: Partial<Usage>): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costMicroUsd: 0,
    provider: "groq",
    model: "openai/gpt-oss-120b",
    ...partial,
  };
}

describe("priceFor and costMicroUsd", () => {
  it("is zero for every free provider", () => {
    for (const provider of config.providers.filter((candidate) => candidate.terms !== "byok")) {
      expect(priceFor(config, provider.id, "any-model")).toBeNull();
    }
    expect(
      costMicroUsd(null, {
        inputTokens: 1e6,
        outputTokens: 1e6,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBe(0);
  });

  it.each([
    ["claude-opus-5-5", 4, 20, 0.2],
    ["claude-sonnet-5-5", 2, 10, 0.1],
    ["claude-haiku-5-5", 0.1, 0.5, 0.01],
  ])("prices %s per MTok with cache writes at 1.25x input", (model, input, output, cacheRead) => {
    const price = priceFor(config, "anthropic", model);
    expect(price).toEqual({
      inputUsdPerMTok: input,
      outputUsdPerMTok: output,
      cacheReadUsdPerMTok: cacheRead,
      cacheWriteUsdPerMTok: input * 1.25,
    });
    expect(
      costMicroUsd(price, {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBe(input * 1_000_000);
  });

  it("sums every token class and rounds up to whole micro-USD", () => {
    const opus = priceFor(config, "anthropic", "claude-opus-5-5");
    expect(
      costMicroUsd(opus, {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 2000,
        cacheWriteTokens: 100,
      }),
    ).toBe(14_900);
    const haiku = priceFor(config, "anthropic", "claude-haiku-5-5");
    expect(
      costMicroUsd(haiku, {
        inputTokens: 1,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBe(1);
  });

  it("refuses to guess the price of an unknown BYOK model", () => {
    expect(() => priceFor(config, "anthropic", "claude-unknown")).toThrow(UnknownPriceError);
    expect(() => priceFor(config, "nope", "m")).toThrow(UnknownPriceError);
  });
});

describe("Budget", () => {
  it("tracks spend and remaining for run and step", () => {
    const budget = new Budget({
      run: { maxTokens: 10_000, maxMicroUsd: 50_000 },
      steps: { s1: { maxTokens: 4000 } },
    });
    budget.charge(
      usage({ inputTokens: 1000, outputTokens: 200, cacheReadTokens: 300, costMicroUsd: 1200 }),
      "s1",
    );
    expect(budget.spent()).toEqual({ tokens: 1500, microUsd: 1200 });
    expect(budget.spent("s1")).toEqual({ tokens: 1500, microUsd: 1200 });
    expect(budget.remaining()).toEqual({ tokens: 8500, microUsd: 48_800 });
    expect(budget.remaining("s1")).toEqual({ tokens: 2500, microUsd: 48_800 });
    expect(budget.remaining("s2")).toEqual({ tokens: 8500, microUsd: 48_800 });
  });

  it("refuses to run without explicit, finite run limits", () => {
    const unlimited = { run: {} } as unknown as ConstructorParameters<typeof Budget>[0];
    expect(() => new Budget(unlimited)).toThrow();
    expect(() => new Budget({ run: { maxTokens: 100, maxMicroUsd: Infinity } })).toThrow();
    expect(() => new Budget({ run: { maxTokens: -1, maxMicroUsd: 0 } })).toThrow();
    expect(() =>
      Budget.forPlan(
        { maxTokens: 100 } as unknown as { maxTokens: number; maxMicroUsd: number },
        [],
      ),
    ).toThrow();
    expect(new Budget({ run: { maxTokens: 100, maxMicroUsd: 0 } }).remaining()).toEqual({
      tokens: 100,
      microUsd: 0,
    });
  });

  it("charges estimated usage like reported usage", () => {
    const budget = new Budget({ run: { maxTokens: 100, maxMicroUsd: 0 } });
    budget.charge(usage({ inputTokens: 60, outputTokens: 20, estimated: true }), "s1");
    expect(budget.spent("s1")).toEqual({ tokens: 80, microUsd: 0 });
    expect(() => {
      budget.charge(usage({ inputTokens: 30, estimated: true }));
    }).toThrow(BudgetExceededError);
  });

  it("throws BudgetExceededError when a step exceeds its token limit and still records the spend", () => {
    const budget = new Budget({
      run: { maxTokens: 10_000, maxMicroUsd: 0 },
      steps: { s1: { maxTokens: 1000 } },
    });
    const error = (() => {
      try {
        budget.charge(usage({ inputTokens: 900, outputTokens: 200 }), "s1");
        return undefined;
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect(error).toMatchObject({
      scope: "step",
      stepId: "s1",
      dimension: "tokens",
      limit: 1000,
      spent: 1100,
    });
    expect(budget.spent()).toEqual({ tokens: 1100, microUsd: 0 });
    expect(budget.remaining("s1").tokens).toBe(0);
  });

  it("throws when the run exceeds its micro-USD cap, including a $0 cap", () => {
    const zero = new Budget({ run: { maxTokens: 1_000_000, maxMicroUsd: 0 } });
    expect(() => {
      zero.charge(usage({ inputTokens: 10, costMicroUsd: 0 }));
    }).not.toThrow();
    expect(() => {
      zero.charge(
        usage({
          inputTokens: 10,
          costMicroUsd: 1,
          provider: "anthropic",
          model: "claude-haiku-5-5",
        }),
      );
    }).toThrow(
      expect.objectContaining({ scope: "run", dimension: "micro_usd", limit: 0, spent: 1 }),
    );
  });

  it("rejects fractional or negative charges", () => {
    const budget = new Budget({ run: { maxTokens: 1000, maxMicroUsd: 1000 } });
    expect(() => {
      budget.charge(usage({ costMicroUsd: 0.5 }));
    }).toThrow();
    expect(() => {
      budget.charge(usage({ inputTokens: -1 }));
    }).toThrow();
  });

  it("derives step limits from plan budget shares", () => {
    const budget = Budget.forPlan({ maxTokens: 100_000, maxMicroUsd: 10_000 }, [
      { id: "s1", budgetShare: 0.6 },
      { id: "s2", budgetShare: 0.25 },
    ]);
    expect(budget.remaining("s1")).toEqual({ tokens: 60_000, microUsd: 6000 });
    expect(budget.remaining("s2")).toEqual({ tokens: 25_000, microUsd: 2500 });
  });
});
