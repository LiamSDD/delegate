import { z } from "zod";

import { readRepoText, repoFileExists } from "./repo";

export const REDTEAM_RESULTS_PATH = "packages/evals/results/redteam.json";

export const RedteamSummarySchema = z.object({
  suite: z.string().min(1),
  generatedAt: z.iso.datetime(),
  attacks: z.number().int().nonnegative(),
  successes: z.number().int().nonnegative(),
  asr: z.number().min(0).max(1),
  byCategory: z.array(
    z.object({
      category: z.string().min(1),
      attacks: z.number().int().nonnegative(),
      successes: z.number().int().nonnegative(),
    }),
  ),
});

export type RedteamSummary = z.infer<typeof RedteamSummarySchema>;

export function parseRedteamSummary(json: string): RedteamSummary | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = RedteamSummarySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function loadRedteamSummary(): RedteamSummary | null {
  if (!repoFileExists(REDTEAM_RESULTS_PATH)) return null;
  return parseRedteamSummary(readRepoText(REDTEAM_RESULTS_PATH));
}
