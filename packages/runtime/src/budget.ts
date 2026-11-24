import { z } from "zod";

import { UsageSchema, type Usage } from "./events";
import { type ModelPrice, type ModelsConfig } from "./models";
import { type TokenUsage } from "./providers/types";

export interface BudgetLimits {
  maxTokens?: number;
  maxMicroUsd?: number;
}

export interface RunBudgetLimits {
  maxTokens: number;
  maxMicroUsd: number;
}

export const RunBudgetLimitsSchema = z.object({
  maxTokens: z.number().int().nonnegative(),
  maxMicroUsd: z.number().int().nonnegative(),
});

export interface BudgetOptions {
  run: RunBudgetLimits;
  steps?: Record<string, BudgetLimits>;
}

export interface BudgetAmount {
  tokens: number;
  microUsd: number;
}

export class BudgetExceededError extends Error {
  override readonly name = "BudgetExceededError";
  constructor(
    readonly scope: "run" | "step",
    readonly dimension: "tokens" | "micro_usd",
    readonly limit: number,
    readonly spent: number,
    readonly stepId?: string,
  ) {
    super(
      `${scope === "run" ? "Run" : `Step ${stepId ?? ""}`} budget exceeded: ${dimension} ${spent} > ${limit}`,
    );
  }
}

export class UnknownPriceError extends Error {
  override readonly name = "UnknownPriceError";
}

export function priceFor(
  config: ModelsConfig,
  providerId: string,
  model: string,
): ModelPrice | null {
  const provider = config.providers.find((candidate) => candidate.id === providerId);
  if (provider === undefined) throw new UnknownPriceError(`Unknown provider ${providerId}`);
  if (provider.terms !== "byok") return null;
  const price = provider.pricing?.[model];
  if (price === undefined)
    throw new UnknownPriceError(`No price for BYOK model ${providerId}/${model}`);
  return price;
}

export function costMicroUsd(price: ModelPrice | null, usage: TokenUsage): number {
  if (price === null) return 0;
  const exact =
    usage.inputTokens * price.inputUsdPerMTok +
    usage.outputTokens * price.outputUsdPerMTok +
    usage.cacheReadTokens * price.cacheReadUsdPerMTok +
    usage.cacheWriteTokens * price.cacheWriteUsdPerMTok;
  return Math.ceil(Number(exact.toFixed(6)));
}

export function totalTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

function remainingOf(limit: number | undefined, spent: number): number {
  return limit === undefined ? Number.POSITIVE_INFINITY : Math.max(0, limit - spent);
}

export class Budget {
  private readonly runSpent: BudgetAmount = { tokens: 0, microUsd: 0 };
  private readonly stepSpent = new Map<string, BudgetAmount>();
  private readonly stepLimits: Map<string, BudgetLimits>;

  private readonly run: RunBudgetLimits;

  constructor(options: BudgetOptions) {
    this.run = RunBudgetLimitsSchema.parse(options.run);
    this.stepLimits = new Map(Object.entries(options.steps ?? {}));
  }

  static forPlan(
    run: RunBudgetLimits,
    steps: readonly { id: string; budgetShare: number }[],
  ): Budget {
    const limits = RunBudgetLimitsSchema.parse(run);
    const stepLimits: Record<string, BudgetLimits> = {};
    for (const step of steps) {
      stepLimits[step.id] = {
        maxTokens: Math.floor(limits.maxTokens * step.budgetShare),
        maxMicroUsd: Math.floor(limits.maxMicroUsd * step.budgetShare),
      };
    }
    return new Budget({ run: limits, steps: stepLimits });
  }

  spent(stepId?: string): BudgetAmount {
    if (stepId === undefined) return { ...this.runSpent };
    return { ...(this.stepSpent.get(stepId) ?? { tokens: 0, microUsd: 0 }) };
  }

  remaining(stepId?: string): BudgetAmount {
    const run = {
      tokens: remainingOf(this.run.maxTokens, this.runSpent.tokens),
      microUsd: remainingOf(this.run.maxMicroUsd, this.runSpent.microUsd),
    };
    if (stepId === undefined) return run;
    const limits = this.stepLimits.get(stepId) ?? {};
    const spent = this.spent(stepId);
    return {
      tokens: Math.min(run.tokens, remainingOf(limits.maxTokens, spent.tokens)),
      microUsd: Math.min(run.microUsd, remainingOf(limits.maxMicroUsd, spent.microUsd)),
    };
  }

  charge(usage: Usage, stepId?: string): void {
    const parsed = UsageSchema.parse(usage);
    const tokens = totalTokens(parsed);
    this.runSpent.tokens += tokens;
    this.runSpent.microUsd += parsed.costMicroUsd;
    if (stepId !== undefined) {
      const step = this.stepSpent.get(stepId) ?? { tokens: 0, microUsd: 0 };
      step.tokens += tokens;
      step.microUsd += parsed.costMicroUsd;
      this.stepSpent.set(stepId, step);
    }

    const run = this.run;
    if (this.runSpent.tokens > run.maxTokens) {
      throw new BudgetExceededError("run", "tokens", run.maxTokens, this.runSpent.tokens);
    }
    if (this.runSpent.microUsd > run.maxMicroUsd) {
      throw new BudgetExceededError("run", "micro_usd", run.maxMicroUsd, this.runSpent.microUsd);
    }
    if (stepId === undefined) return;
    const limits = this.stepLimits.get(stepId);
    const spent = this.spent(stepId);
    if (limits?.maxTokens !== undefined && spent.tokens > limits.maxTokens) {
      throw new BudgetExceededError("step", "tokens", limits.maxTokens, spent.tokens, stepId);
    }
    if (limits?.maxMicroUsd !== undefined && spent.microUsd > limits.maxMicroUsd) {
      throw new BudgetExceededError(
        "step",
        "micro_usd",
        limits.maxMicroUsd,
        spent.microUsd,
        stepId,
      );
    }
  }
}
