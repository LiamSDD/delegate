import { z } from "zod";

import { RunChildSchema, RunStatusSchema, RunStepSchema } from "./schemas";

export const MissionInputSchema = z.strictObject({
  url: z.string().min(1).max(2048),
  focus: z.string().trim().min(1).max(500).optional(),
  department: z.string().trim().min(1).max(120).optional(),
  goal: z.string().trim().min(1).max(900).optional(),
  name: z.string().trim().min(1).max(80).optional(),
  opportunityId: z.string().trim().min(1).max(40).optional(),
});
export type MissionInput = z.infer<typeof MissionInputSchema>;

export const StartRunRequestSchema = z.strictObject({
  missionId: z.string().min(1).max(64),
  input: MissionInputSchema,
});
export type StartRunRequest = z.infer<typeof StartRunRequestSchema>;

export const StartRunResponseSchema = z.object({ runId: z.uuid() });

export const StartAutopilotRequestSchema = z.strictObject({
  goal: z.string().trim().min(3).max(900),
  url: z.string().min(1).max(2048).optional(),
});
export type StartAutopilotRequest = z.infer<typeof StartAutopilotRequestSchema>;

export const RunStepViewSchema = RunStepSchema;

export const RunChildViewSchema = RunChildSchema;
export type RunChildView = z.infer<typeof RunChildViewSchema>;

export const RunListEntrySchema = z.object({
  id: z.uuid(),
  mission: z.string(),
  target: z.string().nullable(),
  status: RunStatusSchema,
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type RunListEntry = z.infer<typeof RunListEntrySchema>;

export const PlanDecisionSchema = z.discriminatedUnion("decision", [
  z.strictObject({ decision: z.literal("approved") }),
  z.strictObject({
    decision: z.literal("rejected"),
    reason: z.string().trim().min(1).max(500).optional(),
  }),
]);
export type PlanDecision = z.infer<typeof PlanDecisionSchema>;
