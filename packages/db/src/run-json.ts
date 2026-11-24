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
  maxTokens: z.int().nonnegative().optional(),
  maxMicroUsd: z.int().nonnegative().optional(),
});

export type RunBudget = z.infer<typeof runBudgetSchema>;

const promptSlug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);

export const promptVersionsSchema = z.record(promptSlug, z.int().positive());

export type PromptVersions = z.infer<typeof promptVersionsSchema>;
