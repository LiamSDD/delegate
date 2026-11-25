import { fileURLToPath } from "node:url";

import { z } from "zod";

export const slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);

export interface DatasetRef {
  name: string;
  version: number;
  file: string;
}

export function datasetFile(dataset: { name: string }, file: string): string {
  return fileURLToPath(new URL(`../../datasets/${dataset.name}/${file}`, import.meta.url));
}

export function humanLabelsPath(dataset: { name: string }): string {
  return datasetFile(dataset, "human-labels.v1.jsonl");
}

export function parseJsonl<T extends { id: string }>(
  source: string,
  schema: z.ZodType<T>,
  label: string,
  validate?: (value: T) => string | undefined,
): T[] {
  const cases: T[] = [];
  const ids = new Set<string>();
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (line.trim() === "") continue;
    let json: unknown;
    try {
      json = JSON.parse(line) as unknown;
    } catch {
      throw new Error(`${label} line ${index + 1} is not JSON`);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success)
      throw new Error(`${label} line ${index + 1} is invalid: ${z.prettifyError(parsed.error)}`);
    const problem = validate?.(parsed.data);
    if (problem !== undefined) throw new Error(`${label} line ${index + 1}: ${problem}`);
    if (ids.has(parsed.data.id)) throw new Error(`Duplicate case id ${parsed.data.id}`);
    ids.add(parsed.data.id);
    cases.push(parsed.data);
  }
  return cases;
}

export function selectById<T extends { id: string }>(
  cases: readonly T[],
  ids: readonly string[] | undefined,
): T[] {
  if (ids === undefined || ids.length === 0) return [...cases];
  const known = new Set(cases.map((c) => c.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) throw new Error(`Unknown case id(s): ${unknown.join(", ")}`);
  const wanted = new Set(ids);
  return cases.filter((c) => wanted.has(c.id));
}
