import { z } from "zod";

import { parseGitHubRepoUrl } from "../../github/repo";

export const SHIP_IMPROVEMENT_KINDS = [
  "test",
  "bugfix",
  "refactor",
  "docs",
  "deps",
  "security",
] as const;
export const SHIP_EFFORTS = ["S", "M"] as const;

const line = (max: number) => z.string().trim().min(1).max(max);

export const ShipImprovementSchema = z.object({
  id: line(80),
  title: line(200),
  rationale: line(2_000),
  files: z.array(line(400)).max(30),
  kind: z.enum(SHIP_IMPROVEMENT_KINDS),
  effort: z.enum(SHIP_EFFORTS),
  acceptance: z.array(line(400)).min(1).max(10),
});
export type ShipImprovement = z.infer<typeof ShipImprovementSchema>;

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
