import { z } from "zod";

import { REPO_TOPICS } from "./docs";
import {
  DiagramSchema,
  IMPROVEMENT_EFFORTS,
  IMPROVEMENT_KINDS,
  RepoClaimSupportSchema,
} from "./schema";

export const REPO_STATE_KIND = "repo-xray.state";

const StateClaimSchema = z.object({
  text: z.string().min(1).max(600),
  evidence: z.array(z.string().min(1).max(40)).max(12),
  support: RepoClaimSupportSchema.optional(),
});

export const RepoStateCheckpointSchema = z.object({
  commit: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .nullable()
    .optional(),
  docFacts: z
    .array(
      z.object({
        path: z.string().min(1).max(300),
        claim: z.string().min(1).max(600),
        quote: z.string().min(1).max(600),
        topic: z.enum(REPO_TOPICS),
        startLine: z.int().min(1),
        endLine: z.int().min(1),
      }),
    )
    .max(500)
    .optional(),
  summary: z.array(StateClaimSchema).max(20).optional(),
  onboarding: z
    .array(z.object({ title: z.string().min(1).max(200), claim: StateClaimSchema }))
    .max(20)
    .optional(),
  responsibilities: z
    .array(z.tuple([z.string().min(1).max(300), StateClaimSchema]))
    .max(60)
    .optional(),
  diagram: DiagramSchema.nullable().optional(),
  improvements: z
    .array(
      StateClaimSchema.extend({
        title: z.string().min(1).max(120),
        files: z.array(z.string().min(1).max(300)).min(1).max(10),
        kind: z.enum(IMPROVEMENT_KINDS),
        effort: z.enum(IMPROVEMENT_EFFORTS),
        acceptance: z.array(z.string().min(1).max(240)).min(1).max(6),
      }),
    )
    .max(12)
    .optional(),
});
export type RepoStateCheckpoint = z.infer<typeof RepoStateCheckpointSchema>;
