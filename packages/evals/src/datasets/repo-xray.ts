import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { RepoXrayInputSchema } from "@delegate/runtime";
import { z } from "zod";

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);

export const REPO_XRAY_DATASET = {
  name: "repo-xray",
  version: 2,
  file: "v2.jsonl",
} as const;

export const REPO_FACT_KINDS = [
  "language",
  "test-framework",
  "manifest",
  "ci",
  "entry-point",
  "dependency",
  "module",
] as const;

export const RepoExpectedFactSchema = z.strictObject({
  id: slug,
  kind: z.enum(REPO_FACT_KINDS),
  value: z.string().min(1).max(200),
  proposition: z.string().min(10).max(300),
  sourceUrl: z.url({ protocol: /^https$/ }),
  verifiedAt: z.iso.date(),
});
export type RepoExpectedFact = z.infer<typeof RepoExpectedFactSchema>;

export const RepoXrayCaseSchema = z.strictObject({
  id: slug,
  mission: z.literal("repo-xray"),
  version: z.number().int().positive(),
  input: z.strictObject({
    url: z.url({ protocol: /^https$/ }),
    ref: z.string().min(1).max(200).optional(),
  }),
  repo: z.strictObject({
    owner: z.string().min(1),
    name: z.string().min(1),
    language: z.string().min(1),
    size: z.enum(["small", "medium", "large"]),
  }),
  expectedFacts: z.array(RepoExpectedFactSchema).min(3).max(6),
  tags: z.array(slug),
  notes: z.string().optional(),
});
export type RepoXrayCase = z.infer<typeof RepoXrayCaseSchema>;

export function parseRepoXrayDataset(source: string): RepoXrayCase[] {
  const cases: RepoXrayCase[] = [];
  const ids = new Set<string>();
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (line.trim() === "") continue;
    const parsed = RepoXrayCaseSchema.safeParse(JSON.parse(line));
    if (!parsed.success)
      throw new Error(`repo-xray dataset line ${index + 1}: ${parsed.error.message}`);
    if (!RepoXrayInputSchema.safeParse(parsed.data.input).success)
      throw new Error(`repo-xray dataset line ${index + 1}: input is not a GitHub repository`);
    if (ids.has(parsed.data.id)) throw new Error(`Duplicate repo-xray case id ${parsed.data.id}`);
    ids.add(parsed.data.id);
    cases.push(parsed.data);
  }
  return cases;
}

export const REPO_XRAY_DATASET_PATH = fileURLToPath(
  new URL(`../../datasets/repo-xray/${REPO_XRAY_DATASET.file}`, import.meta.url),
);

export function loadRepoXrayDataset(path = REPO_XRAY_DATASET_PATH): RepoXrayCase[] {
  return parseRepoXrayDataset(readFileSync(path, "utf8"));
}
