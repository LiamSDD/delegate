import { z } from "zod";

export const LEARNED_ROUTING_VERSION = 1;
export const LEARNED_ROUTING_FILE = "config/routing.learned.json";
export const ROUTING_ROLES = ["planner", "worker", "fast"] as const;
export type RoutingRole = (typeof ROUTING_ROLES)[number];

const name = z.string().min(1);

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
    error: "ci lower bound is above its upper bound",
    path: ["ci"],
  });
export type LearnedModel = z.infer<typeof LearnedModelSchema>;

export const LearnedEntrySchema = z
  .strictObject({
    mission: name,
    role: z.enum(ROUTING_ROLES),
    order: z.array(LearnedModelSchema),
    decision: z.enum(["learned", "insufficient-evidence"]),
    reason: z.string(),
  })
  .superRefine((entry, ctx) => {
    const seen = new Set<string>();
    for (const [index, model] of entry.order.entries()) {
      const key = `${model.provider}\u0000${model.model}`;
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
    version: z.literal(LEARNED_ROUTING_VERSION),
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
