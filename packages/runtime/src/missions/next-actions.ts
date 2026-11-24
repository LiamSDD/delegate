import { z } from "zod";

export const NEXT_ACTIONS_KIND = "next-actions";

export const NextActionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).max(120),
  description: z.string().max(300).optional(),
  missionId: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  available: z.boolean(),
  opportunityId: z.string().min(1).optional(),
});
export type NextAction = z.infer<typeof NextActionSchema>;

export const NextActionsSchema = z.object({
  missionId: z.string().min(1),
  actions: z.array(NextActionSchema).max(20),
});
export type NextActions = z.infer<typeof NextActionsSchema>;
