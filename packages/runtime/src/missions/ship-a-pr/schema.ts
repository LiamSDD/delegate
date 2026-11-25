import { z } from "zod";

import {
  ActorSchema,
  DiffStatSchema,
  PullRequestOpenedPayloadSchema,
  ShipModeSchema,
  TestRunSummarySchema,
  type DiffStat,
  type ShipMode,
  type TestRunSummary,
} from "../../events";
import { SANDBOX_KINDS } from "../../sandbox/types";
import { ProjectProfileSchema } from "./detect";

export const DIFF_LIMITS = {
  maxPatchBytes: 400_000,
  maxFiles: 50,
  maxFileBytes: 400_000,
  maxContentBytes: 1_000_000,
  commandOutputChars: 3_800,
} as const;

export const DiffFileSchema = z.object({
  path: z.string().min(1).max(400),
  status: z.enum(["added", "modified", "deleted"]),
  mode: z.enum(["100644", "100755"]),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
export type DiffFile = z.infer<typeof DiffFileSchema>;

export const DiffContentSchema = z.object({
  path: z.string().min(1).max(400),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  base64: z
    .string()
    .max(Math.ceil(DIFF_LIMITS.maxFileBytes / 3) * 4)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/),
});
export type DiffContent = z.infer<typeof DiffContentSchema>;

export const RepoDiffSchema = z.object({
  baseSha: z.string().regex(/^[0-9a-f]{40}$/),
  patch: z.string().max(DIFF_LIMITS.maxPatchBytes),
  files: z.array(DiffFileSchema).max(DIFF_LIMITS.maxFiles),
  contents: z.array(DiffContentSchema).max(DIFF_LIMITS.maxFiles).optional(),
  stat: DiffStatSchema,
});
export type RepoDiff = z.infer<typeof RepoDiffSchema>;

export const PR_FOOTER =
  "Produced by Delegate's Ship-a-PR mission: an Engineer agent implemented this change in an isolated sandbox, ran the repository's own commands, and a human approved the diff before it was pushed.";

export function describeRun(summary: TestRunSummary): string {
  if (summary.command === null) return "not available";
  if (summary.timedOut === true) return "timed out";
  const seconds = (summary.durationMs / 1000).toFixed(1);
  return `${summary.passed === true ? "passed" : "failed"} (exit ${summary.exitCode ?? "?"}, ${seconds} s)`;
}

export const SHIP_WORKSPACE_KIND = "ship-workspace";
export const SHIP_TEST_REPORT_KIND = "ship-test-report";
export const SHIP_DIFF_KIND = "ship-diff";
export const SHIP_RESULT_KIND = "ship-result";

export const ShipWorkspaceSchema = z.object({
  sandboxKind: z.enum(SANDBOX_KINDS),
  sandboxId: z.string().min(1).max(200),
  repo: z.string().min(3).max(200),
  ref: z.string().max(200).nullable(),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/),
  baselineTree: z.string().regex(/^[0-9a-f]{40}$/),
  profile: ProjectProfileSchema,
  installed: TestRunSummarySchema,
});
export type ShipWorkspace = z.infer<typeof ShipWorkspaceSchema>;

export const TEST_PHASES = ["baseline", "after"] as const;

export const ShipTestReportSchema = z.object({
  phase: z.enum(TEST_PHASES),
  test: TestRunSummarySchema,
  lint: TestRunSummarySchema.nullable(),
  typecheck: TestRunSummarySchema.nullable(),
  testOutput: z.string().max(DIFF_LIMITS.commandOutputChars),
});
export type ShipTestReport = z.infer<typeof ShipTestReportSchema>;

export const ShipDiffSchema = RepoDiffSchema.extend({
  rounds: z.number().int().nonnegative(),
  engineerOutcome: z.string().max(40),
  summary: z.string().max(2_000),
});
export type ShipDiff = z.infer<typeof ShipDiffSchema>;

export const SHIP_RESULT_STATUSES = ["opened", "patch_ready", "rejected"] as const;

export const ShipResultSchema = z.object({
  status: z.enum(SHIP_RESULT_STATUSES),
  mode: ShipModeSchema,
  repo: z.string().min(3).max(200),
  base: z.string().max(250),
  branch: z.string().max(250),
  title: z.string().min(1).max(200),
  reason: z.string().max(500),
  diffStat: DiffStatSchema,
  baseline: TestRunSummarySchema,
  after: TestRunSummarySchema,
  pullRequest: PullRequestOpenedPayloadSchema.optional(),
  patch: z
    .object({
      fileName: z.string().min(1).max(200),
      content: z.string().max(DIFF_LIMITS.maxPatchBytes),
    })
    .optional(),
  testReport: z.string().max(20_000).optional(),
});
export type ShipResult = z.infer<typeof ShipResultSchema>;

export const ShipDecisionSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("approved"), approvedBy: ActorSchema.optional() }),
  z.object({
    decision: z.literal("rejected"),
    reason: z.string().max(500).optional(),
    rejectedBy: ActorSchema.optional(),
  }),
]);
export type ShipDecision = z.infer<typeof ShipDecisionSchema>;

export interface ShipApprovalRequest {
  approvalId: string;
  mode: ShipMode;
  repo: string;
  base: string;
  branch: string;
  title: string;
  diffStat: DiffStat;
  patchArtifactId: string;
  baseline: TestRunSummary;
  after: TestRunSummary;
  reason: string;
}

export type AwaitShipApproval = (
  request: ShipApprovalRequest,
  signal?: AbortSignal,
) => Promise<ShipDecision>;
