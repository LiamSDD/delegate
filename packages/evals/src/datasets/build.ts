import { readFileSync } from "node:fs";

import { BuildAgentInputSchema } from "@delegate/runtime";
import { z } from "zod";

import { CheckSchema } from "../types";
import { datasetFile, parseJsonl, slug } from "./jsonl";

export const BUILD_DATASET = { name: "build-agent", version: 1, file: "v1.jsonl" } as const;

export const SiteQuestionSchema = z.strictObject({
  id: slug,
  question: z.string().min(5).max(300),
  expectedAnswer: z.string().min(2).max(600),
  mustInclude: z.array(z.string().min(1).max(80)).min(1).max(3),
  sourceUrl: z.url({ protocol: /^https$/ }),
  verifiedAt: z.iso.date(),
});
export type SiteQuestion = z.infer<typeof SiteQuestionSchema>;

export const OutOfScopeQuestionSchema = z.strictObject({
  id: slug,
  question: z.string().min(5).max(300),
  why: z.string().min(5).max(300),
});
export type OutOfScopeQuestion = z.infer<typeof OutOfScopeQuestionSchema>;

export const BuildCaseSchema = z.strictObject({
  id: slug,
  mission: z.literal("build"),
  version: z.number().int().positive(),
  input: z.strictObject({
    url: z.url({ protocol: /^https$/ }),
    goal: z.string().min(1).max(300),
    name: z.string().min(1).max(80).optional(),
  }),
  site: z.strictObject({
    name: z.string().min(1).max(120),
    country: z.string().regex(/^[A-Z]{2}$/),
    kind: slug,
  }),
  questions: z.array(SiteQuestionSchema).min(6).max(10),
  outOfScope: z.array(OutOfScopeQuestionSchema).length(3),
  checks: z.array(CheckSchema),
  rubric: z.array(z.string().min(1)),
  tags: z.array(slug),
  notes: z.string().optional(),
});
export type BuildCase = z.infer<typeof BuildCaseSchema>;

export function siteHost(url: string): string {
  return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
}

export function onSite(url: string, siteUrl: string): boolean {
  try {
    const host = siteHost(url);
    const site = siteHost(siteUrl);
    return host === site || host.endsWith(`.${site}`);
  } catch {
    return false;
  }
}

export function parseBuildDataset(source: string): BuildCase[] {
  return parseJsonl(source, BuildCaseSchema, "build-agent dataset", (evalCase) => {
    if (!BuildAgentInputSchema.safeParse(evalCase.input).success)
      return "input is not a valid build-agent input";
    const offSite = evalCase.questions.filter((q) => !onSite(q.sourceUrl, evalCase.input.url));
    if (offSite.length > 0)
      return `answers must come from the crawled site: ${offSite.map((q) => q.id).join(", ")}`;
    const ids = [...evalCase.questions, ...evalCase.outOfScope].map((q) => q.id);
    return new Set(ids).size === ids.length ? undefined : "duplicate question id";
  });
}

export function loadBuildDataset(
  path: string = datasetFile(BUILD_DATASET, BUILD_DATASET.file),
): BuildCase[] {
  return parseBuildDataset(readFileSync(path, "utf8"));
}
