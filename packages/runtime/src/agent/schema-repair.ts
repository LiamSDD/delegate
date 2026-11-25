import { type z } from "zod";

type Issue = z.core.$ZodIssue;

const MAX_ISSUES_DESCRIBED = 12;
const MAX_PASSES = 6;
const MAX_RESHAPES = 2;
const NUMERIC = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const WRAPPER_KEYS = new Set([
  "result",
  "results",
  "data",
  "output",
  "response",
  "answer",
  "json",
  "arguments",
  "args",
  "input",
  "parameters",
]);

export interface FlatIssue {
  path: PropertyKey[];
  issue: Issue;
}

export function flattenIssues(
  issues: readonly Issue[],
  prefix: readonly PropertyKey[] = [],
): FlatIssue[] {
  return issues.flatMap((issue) => {
    const path = [...prefix, ...issue.path];
    if (issue.code === "invalid_union" && issue.errors.length > 0) {
      const closest = [...issue.errors].sort((a, b) => a.length - b.length)[0] ?? [];
      if (closest.length > 0) return flattenIssues(closest, path);
    }
    return [{ path, issue }];
  });
}

export function describeIssues(error: z.ZodError): string {
  return flattenIssues(error.issues)
    .slice(0, MAX_ISSUES_DESCRIBED)
    .map(
      ({ path, issue }) =>
        `- ${path.length === 0 ? "(root)" : path.map(String).join(".")}: ${issue.message}`,
    )
    .join("\n");
}

export type SchemaFit<T> =
  | { ok: true; value: T; input: unknown; repairs: string[] }
  | { ok: false; error: z.ZodError; repairs: string[] };

type Container = Record<PropertyKey, unknown>;

function isRecord(value: unknown): value is Container {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEmbedded(text: string): unknown {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function matchesShape(expected: string, value: unknown): boolean {
  return expected === "array" ? Array.isArray(value) : isRecord(value);
}

function normalised(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "_");
}

function retyped(issue: Issue, target: unknown): { value: unknown } | undefined {
  if (issue.code === "invalid_value") {
    if (typeof target !== "string") return undefined;
    const matches = issue.values.filter(
      (candidate) => typeof candidate === "string" && normalised(candidate) === normalised(target),
    );
    return matches.length === 1 ? { value: matches[0] } : undefined;
  }
  if (issue.code !== "invalid_type" || target === undefined || target === null) return undefined;
  const expected = issue.expected;
  if (typeof target === "string") {
    const text = target.trim();
    if ((expected === "number" || expected === "int") && NUMERIC.test(text))
      return { value: Number(text) };
    if (expected === "boolean" && /^(true|false)$/i.test(text))
      return { value: text.toLowerCase() === "true" };
    if (expected === "array" || expected === "object" || expected === "record") {
      const embedded = parseEmbedded(text);
      if (embedded !== undefined && matchesShape(expected, embedded)) return { value: embedded };
    }
  }
  if (expected === "string" && (typeof target === "number" || typeof target === "boolean"))
    return { value: String(target) };
  if (expected === "array" && !Array.isArray(target) && target !== "") return { value: [target] };
  return undefined;
}

function applyFix(holder: { root: unknown }, flat: FlatIssue, repairs: string[]): boolean {
  const { path, issue } = flat;
  let parent: unknown = holder;
  let key: PropertyKey = "root";
  for (const segment of path) {
    const next: unknown = (parent as Container)[key];
    if (typeof next !== "object" || next === null) return false;
    parent = next;
    key = segment;
  }
  const slot = parent as Container;
  const target = slot[key];
  const where = path.length === 0 ? "(root)" : path.map(String).join(".");
  if (issue.code === "unrecognized_keys" && isRecord(target)) {
    for (const extra of issue.keys) Reflect.deleteProperty(target, extra);
    repairs.push(`${where}: removed unknown keys`);
    return issue.keys.length > 0;
  }
  if (issue.code === "invalid_type" && target === null && path.length > 0 && isRecord(parent)) {
    Reflect.deleteProperty(slot, key);
    repairs.push(`${where}: null removed`);
    return true;
  }
  const fixed = retyped(issue, target);
  if (fixed === undefined) return false;
  slot[key] = fixed.value;
  repairs.push(`${where}: ${issue.code === "invalid_value" ? "enum value" : "type"} corrected`);
  return true;
}

function soleArrayField(schema: z.ZodType): string | undefined {
  const probe = schema.safeParse({});
  if (probe.success) return undefined;
  const fields = flattenIssues(probe.error.issues).filter(
    ({ path, issue }) =>
      path.length === 1 && issue.code === "invalid_type" && issue.expected === "array",
  );
  const only = fields.length === 1 ? fields[0]?.path[0] : undefined;
  return typeof only === "string" ? only : undefined;
}

function reshaped(schema: z.ZodType, value: unknown): { value: unknown; note: string }[] {
  const shapes: { value: unknown; note: string }[] = [];
  if (Array.isArray(value)) {
    const field = soleArrayField(schema);
    if (field !== undefined)
      shapes.push({ value: { [field]: value }, note: `(root): array placed under ${field}` });
  }
  if (isRecord(value)) {
    const keys = Object.keys(value);
    const only = keys.length === 1 ? keys[0] : undefined;
    if (only !== undefined && WRAPPER_KEYS.has(only.toLowerCase()))
      shapes.push({ value: value[only], note: `(root): unwrapped ${only}` });
  }
  return shapes;
}

function fitInPlace<T>(schema: z.ZodType<T>, input: unknown, repairs: string[]): SchemaFit<T> {
  const holder = { root: input };
  let parsed = schema.safeParse(holder.root);
  for (let pass = 0; pass < MAX_PASSES && !parsed.success; pass += 1) {
    let changed = false;
    for (const flat of flattenIssues(parsed.error.issues))
      changed = applyFix(holder, flat, repairs) || changed;
    if (!changed) break;
    parsed = schema.safeParse(holder.root);
  }
  return parsed.success
    ? { ok: true, value: parsed.data, input: holder.root, repairs }
    : { ok: false, error: parsed.error, repairs };
}

export function fitToSchema<T>(schema: z.ZodType<T>, input: unknown, reshapes = 0): SchemaFit<T> {
  const direct = schema.safeParse(input);
  if (direct.success) return { ok: true, value: direct.data, input, repairs: [] };
  const first = fitInPlace(schema, structuredClone(input), []);
  if (first.ok) return first;
  if (reshapes < MAX_RESHAPES)
    for (const shape of reshaped(schema, input)) {
      const again = fitToSchema(schema, shape.value, reshapes + 1);
      if (again.ok) return { ...again, repairs: [shape.note, ...again.repairs] };
    }
  return { ok: false, error: direct.error, repairs: [] };
}
