import { z } from "zod";

import { ChildMissionIdSchema, ChildOutcomeSchema, ChildHandoffSchema } from "../../events";
import { CompanyUrlSchema } from "../company-xray/input";
import { GOAL_MAX_CHARS } from "../custom-goal/input";

export const AUTOPILOT_MISSION_ID = "autopilot";
export const AUTOPILOT_REPORT_KIND = "autopilot-report";
export const AUTOPILOT_POLICY_ID = "autopilot";
export const AUTOPILOT_CHILD_TOOL = "autopilot.start_child";

export const AUTOPILOT_LIMITS = {
  maxChildren: 4,
  maxDepth: 1,
  maxWallMs: 45 * 60_000,
  maxTokens: 1_200_000,
} as const;
export type AutopilotLimits = { [K in keyof typeof AUTOPILOT_LIMITS]: number };

export const AutopilotInputSchema = z.strictObject({
  goal: z.string().trim().min(3).max(GOAL_MAX_CHARS),
  url: CompanyUrlSchema.optional(),
});
export type AutopilotInput = z.infer<typeof AutopilotInputSchema>;

export const AUTOPILOT_TIERS = ["guest", "connected"] as const;
export const AutopilotTierSchema = z.enum(AUTOPILOT_TIERS);
export type AutopilotTier = z.infer<typeof AutopilotTierSchema>;

export const AUTOPILOT_TRACKS = ["company", "repo", "brief-only"] as const;
export const AutopilotTrackSchema = z.enum(AUTOPILOT_TRACKS);
export type AutopilotTrack = z.infer<typeof AutopilotTrackSchema>;

export const AUTOPILOT_STOP_REASONS = [
  "child_failed",
  "handoff_failed",
  "token_cap",
  "wall_time",
  "max_children",
  "quota",
  "cancelled",
  "unavailable",
] as const;
export const AutopilotStopReasonSchema = z.enum(AUTOPILOT_STOP_REASONS);
export type AutopilotStopReason = z.infer<typeof AutopilotStopReasonSchema>;

export const AutopilotReportStepSchema = z.object({
  nodeId: z.string().min(1).max(40),
  missionId: ChildMissionIdSchema,
  label: z.string().min(1).max(120),
  childRunId: z.uuid().nullable(),
  status: z.enum(["completed", "failed", "not_started"]),
  outcome: ChildOutcomeSchema.nullable(),
  from: ChildHandoffSchema.optional(),
  note: z.string().max(400).optional(),
});
export type AutopilotReportStep = z.infer<typeof AutopilotReportStepSchema>;

export const AutopilotReportSchema = z.object({
  missionId: z.literal(AUTOPILOT_MISSION_ID),
  goal: z.string().min(1).max(GOAL_MAX_CHARS),
  status: z.enum(["completed", "stopped", "failed"]),
  headline: z.string().min(1).max(400),
  track: AutopilotTrackSchema.nullable(),
  tier: AutopilotTierSchema,
  steps: z.array(AutopilotReportStepSchema).max(8),
  needsHuman: z.array(z.string().min(1).max(300)).max(12),
  stop: z
    .object({ reason: AutopilotStopReasonSchema, message: z.string().min(1).max(400) })
    .nullable(),
  usage: z.object({
    children: z.int().nonnegative(),
    tokens: z.int().nonnegative(),
    wallMs: z.int().nonnegative(),
  }),
  limits: z.object({
    maxChildren: z.int().positive(),
    maxDepth: z.int().positive(),
    maxWallMs: z.int().positive(),
    maxTokens: z.int().positive(),
  }),
  generatedAt: z.iso.datetime({ offset: true }),
});
export type AutopilotReport = z.infer<typeof AutopilotReportSchema>;
