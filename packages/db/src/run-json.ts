import { z } from "zod";

export const runTotalsSchema = z.strictObject({
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  cacheReadTokens: z.int().nonnegative(),
  cacheWriteTokens: z.int().nonnegative(),
  costMicroUsd: z.int().nonnegative(),
});

export type RunTotals = z.infer<typeof runTotalsSchema>;

export const emptyRunTotals: RunTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costMicroUsd: 0,
};

export const runBudgetSchema = z.strictObject({
  maxTokens: z.int().positive().optional(),
  maxCostMicroUsd: z.int().nonnegative().optional(),
  maxSteps: z.int().positive().optional(),
});

export type RunBudget = z.infer<typeof runBudgetSchema>;

export const promptVersionsSchema = z.record(z.string(), z.string());

export type PromptVersions = z.infer<typeof promptVersionsSchema>;
