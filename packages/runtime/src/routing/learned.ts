import { z } from "zod";

import { ModelRoleSchema, type ModelRole, type RoutingOrdering } from "../events";
import { type ChainEntry } from "../models";

const name = z.string().min(1);

export const LEARNED_DECISIONS = ["learned", "insufficient-evidence"] as const;

export const LearnedModelSchema = z
  .strictObject({
    provider: name,
    model: name,
    trials: z.number().int().nonnegative(),
    passRate: z.number().min(0).max(1),
    ci: z.tuple([z.number(), z.number()]),
    p50LatencyMs: z.number().nonnegative().nullable(),
  })
  .refine((model) => model.ci[0] <= model.ci[1], {
    message: "ci lower bound is above its upper bound",
    path: ["ci"],
  });
export type LearnedModel = z.infer<typeof LearnedModelSchema>;

function modelKey(model: { provider: string; model: string }): string {
  return `${model.provider}\u0000${model.model}`;
}

export const LearnedEntrySchema = z
  .strictObject({
    mission: name,
    role: ModelRoleSchema,
    order: z.array(LearnedModelSchema),
    decision: z.enum(LEARNED_DECISIONS),
    reason: z.string(),
  })
  .superRefine((entry, ctx) => {
    const seen = new Set<string>();
    for (const [index, model] of entry.order.entries()) {
      const key = modelKey(model);
      if (seen.has(key))
        ctx.addIssue({
          code: "custom",
          message: `${model.provider}/${model.model} is listed twice`,
          path: ["order", index],
        });
      seen.add(key);
    }
  });
export type LearnedEntry = z.infer<typeof LearnedEntrySchema>;

export const LearnedRoutingSchema = z
  .strictObject({
    version: z.literal(1),
    generatedAt: z.iso.datetime({ offset: true }),
    source: z.strictObject({
      resultFiles: z.array(name),
      trials: z.number().int().nonnegative(),
    }),
    minTrials: z.number().int().nonnegative(),
    entries: z.array(LearnedEntrySchema),
  })
  .superRefine((routing, ctx) => {
    const seen = new Set<string>();
    for (const [index, entry] of routing.entries.entries()) {
      const key = `${entry.mission}\u0000${entry.role}`;
      if (seen.has(key))
        ctx.addIssue({
          code: "custom",
          message: `Two entries for mission ${entry.mission} and role ${entry.role}`,
          path: ["entries", index],
        });
      seen.add(key);
    }
  });
export type LearnedRouting = z.infer<typeof LearnedRoutingSchema>;

export type ParsedLearnedRouting =
  { ok: true; routing: LearnedRouting } | { ok: false; reason: string };

const MAX_REASON_ISSUES = 3;

export function parseLearnedRouting(input: unknown): ParsedLearnedRouting {
  const parsed = LearnedRoutingSchema.safeParse(input);
  if (parsed.success) return { ok: true, routing: parsed.data };
  const reason = parsed.error.issues
    .slice(0, MAX_REASON_ISSUES)
    .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  return { ok: false, reason };
}

export function learnedEntryFor(
  routing: LearnedRouting | undefined,
  mission: string | undefined,
  role: ModelRole,
): LearnedEntry | undefined {
  if (routing === undefined || mission === undefined) return undefined;
  return routing.entries.find(
    (entry) => entry.mission === mission && entry.role === role && entry.decision === "learned",
  );
}

export interface OrderedChain {
  chain: ChainEntry[];
  ordering: RoutingOrdering;
}

export function applyLearnedOrder(
  chain: readonly ChainEntry[],
  entry: Pick<LearnedEntry, "order"> | undefined,
): OrderedChain {
  if (entry === undefined) return { chain: [...chain], ordering: "configured" };
  const rank = new Map(entry.order.map((model, index) => [modelKey(model), index]));
  const key = (candidate: ChainEntry) =>
    modelKey({ provider: candidate.provider.id, model: candidate.model });
  const listed = chain
    .filter((candidate) => rank.has(key(candidate)))
    .sort((a, b) => (rank.get(key(a)) ?? 0) - (rank.get(key(b)) ?? 0));
  if (listed.length === 0) return { chain: [...chain], ordering: "configured" };
  const rest = chain.filter((candidate) => !rank.has(key(candidate)));
  return { chain: [...listed, ...rest], ordering: "learned" };
}

export function leadWithOfflineEntry(chain: readonly ChainEntry[]): ChainEntry[] {
  const index = chain.findIndex((entry) => !entry.interactive);
  if (index <= 0) return [...chain];
  const head = chain[index];
  if (head === undefined) return [...chain];
  return [head, ...chain.slice(0, index), ...chain.slice(index + 1)];
}
