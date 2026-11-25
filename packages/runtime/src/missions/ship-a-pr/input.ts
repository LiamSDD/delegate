import { z } from "zod";

import { parseGitHubRepoUrl } from "../../github/repo";
import {
  IMPROVEMENT_EFFORTS,
  IMPROVEMENT_KINDS,
  RepoImprovementSchema,
  type RepoImprovement,
} from "../repo-xray/schema";

export const SHIP_IMPROVEMENT_KINDS = IMPROVEMENT_KINDS;
export const SHIP_EFFORTS = IMPROVEMENT_EFFORTS;

export const ShipImprovementSchema = RepoImprovementSchema;
export type ShipImprovement = RepoImprovement;

export const GitRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, "Use a branch, tag or commit name")
  .refine((ref) => !ref.includes("..") && !ref.endsWith(".lock") && !ref.endsWith("/"), {
    error: "Not a valid git ref",
  });

export const ShipAPrInputSchema = z.object({
  repoUrl: z
    .string()
    .trim()
    .max(300)
    .refine((url) => parseGitHubRepoUrl(url) !== null, {
      error: "Use a public https://github.com/<owner>/<repo> URL",
    }),
  ref: GitRefSchema.optional(),
  improvement: ShipImprovementSchema,
});
export type ShipAPrInput = z.infer<typeof ShipAPrInputSchema>;
