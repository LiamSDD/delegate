import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { CheckSchema } from "../types";

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);

export const XRAY_DATASET = {
  name: "company-xray",
  version: 1,
  file: "v1.jsonl",
} as const;

export const XRAY_EXCLUDED_DOMAINS: readonly string[] = ["supabase.com"];

export const ExpectedFactSchema = z.strictObject({
  id: slug,
  proposition: z.string().min(10).max(300),
  justification: z.string().min(5).max(400),
  sourceUrl: z.url({ protocol: /^https$/ }),
  verifiedAt: z.iso.date(),
});
export type ExpectedFact = z.infer<typeof ExpectedFactSchema>;

export const CompanySizeSchema = z.enum(["small", "medium", "large"]);

export const XrayCaseSchema = z.strictObject({
  id: slug,
  mission: z.literal("xray"),
  version: z.number().int().positive(),
  input: z.strictObject({
    url: z.url({ protocol: /^https?$/ }),
    focus: z.string().min(1).max(500).optional(),
  }),
  company: z.strictObject({
    name: z.string().min(1).max(120),
    country: z.string().regex(/^[A-Z]{2}$/),
    industry: slug,
    size: CompanySizeSchema,
  }),
  expectedFacts: z.array(ExpectedFactSchema).min(2).max(5),
  difficulty: z.string().min(1).max(600),
  checks: z.array(CheckSchema),
  rubric: z.array(z.string().min(1)),
  tags: z.array(slug),
  notes: z.string().optional(),
});
export type XrayCase = z.infer<typeof XrayCaseSchema>;

function isExcluded(url: string): boolean {
  const host = new URL(url).hostname.toLowerCase();
  return XRAY_EXCLUDED_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export function parseXrayDataset(source: string): XrayCase[] {
  const cases: XrayCase[] = [];
  const ids = new Set<string>();
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (line.trim() === "") continue;
    const parsed = XrayCaseSchema.safeParse(JSON.parse(line) as unknown);
    if (!parsed.success)
      throw new Error(`Dataset line ${index + 1} is invalid: ${z.prettifyError(parsed.error)}`);
    const evalCase = parsed.data;
    if (ids.has(evalCase.id)) throw new Error(`Duplicate case id ${evalCase.id}`);
    if (isExcluded(evalCase.input.url))
      throw new Error(`Case ${evalCase.id} targets an excluded development company`);
    for (const fact of evalCase.expectedFacts) {
      if (evalCase.expectedFacts.filter((other) => other.id === fact.id).length > 1)
        throw new Error(`Case ${evalCase.id} has duplicate fact id ${fact.id}`);
    }
    ids.add(evalCase.id);
    cases.push(evalCase);
  }
  return cases;
}

export function datasetPath(file: string = XRAY_DATASET.file): string {
  return fileURLToPath(new URL(`../../datasets/${XRAY_DATASET.name}/${file}`, import.meta.url));
}

export function loadXrayDataset(path: string = datasetPath()): XrayCase[] {
  return parseXrayDataset(readFileSync(path, "utf8"));
}

export function selectCases(cases: readonly XrayCase[], ids: readonly string[] | undefined) {
  if (ids === undefined || ids.length === 0) return [...cases];
  const known = new Set(cases.map((c) => c.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) throw new Error(`Unknown case id(s): ${unknown.join(", ")}`);
  const wanted = new Set(ids);
  return cases.filter((c) => wanted.has(c.id));
}
