import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { GOAL_MAX_CHARS } from "@delegate/runtime";
import { z } from "zod";

import { CheckSchema } from "../types";

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);

export const CUSTOM_GOAL_DATASET = {
  name: "custom-goal",
  version: 1,
  file: "v1.jsonl",
} as const;

export const ExpectedTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("domain"), host: z.string().min(3).max(253) }),
  z.strictObject({ kind: z.literal("brand"), name: z.string().min(2).max(80) }),
  z.strictObject({ kind: z.literal("none") }),
]);
export type ExpectedTarget = z.infer<typeof ExpectedTargetSchema>;

export const CustomGoalCaseSchema = z.strictObject({
  id: slug,
  mission: z.literal("custom-goal"),
  version: z.number().int().positive(),
  input: z.strictObject({ goal: z.string().trim().min(3).max(GOAL_MAX_CHARS) }),
  expected: z.strictObject({
    target: ExpectedTargetSchema,
    minActions: z.number().int().min(1).max(8),
    workstreams: z.array(z.string().min(1)).max(5),
  }),
  checks: z.array(CheckSchema),
  rubric: z.array(z.string().min(1)),
  tags: z.array(slug),
  notes: z.string().optional(),
});
export type CustomGoalCase = z.infer<typeof CustomGoalCaseSchema>;

export function parseCustomGoalDataset(source: string): CustomGoalCase[] {
  const cases: CustomGoalCase[] = [];
  const ids = new Set<string>();
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (line.trim() === "") continue;
    const parsed = CustomGoalCaseSchema.safeParse(JSON.parse(line) as unknown);
    if (!parsed.success)
      throw new Error(`Dataset line ${index + 1} is invalid: ${z.prettifyError(parsed.error)}`);
    if (ids.has(parsed.data.id)) throw new Error(`Duplicate case id ${parsed.data.id}`);
    ids.add(parsed.data.id);
    cases.push(parsed.data);
  }
  return cases;
}

export function customGoalDatasetPath(file: string = CUSTOM_GOAL_DATASET.file): string {
  return fileURLToPath(
    new URL(`../../datasets/${CUSTOM_GOAL_DATASET.name}/${file}`, import.meta.url),
  );
}

export function loadCustomGoalDataset(path: string = customGoalDatasetPath()): CustomGoalCase[] {
  return parseCustomGoalDataset(readFileSync(path, "utf8"));
}
