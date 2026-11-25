import { z } from "zod";

import { CompanyUrlSchema } from "../company-xray/input";

export const GOAL_MAX_CHARS = 900;

export const CustomGoalInputSchema = z.object({
  goal: z.string().trim().min(3).max(GOAL_MAX_CHARS),
  url: CompanyUrlSchema.optional(),
});

export type CustomGoalInput = z.infer<typeof CustomGoalInputSchema>;
