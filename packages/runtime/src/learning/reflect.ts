import { z } from "zod";

import { RunAbortedError, type RunContext } from "../agent/context";
import { callStructured } from "../agent/structured";
import { type PromptFile } from "../prompts";
import { RunLessonsSchema, type RunLessons } from "./lessons";
import { deterministicLessons, type LoggedRun } from "./playbook";

export const REFLECT_LIMITS = { keep: 12, maxTokens: 400 } as const;

export interface ReflectOptions {
  ctx?: RunContext;
  prompt?: PromptFile;
}

export async function reflectRun(
  run: LoggedRun,
  key: string,
  options: ReflectOptions = {},
): Promise<RunLessons> {
  const base = deterministicLessons(run, key);
  if (options.ctx === undefined || options.prompt === undefined) return base;
  const ids = base.lessons.map((_, index) => `c${index + 1}`);
  const [firstId, ...restIds] = ids;
  if (firstId === undefined) return base;
  const schema = z.object({
    keep: z.array(z.enum([firstId, ...restIds])).max(REFLECT_LIMITS.keep),
  });
  const user = JSON.stringify({
    outcome: base.outcome,
    success: Math.round(base.success * 1000) / 1000,
    candidates: base.lessons.map((lesson, index) => ({ id: ids[index], text: lesson.text })),
  });
  try {
    const result = await callStructured(options.ctx, {
      role: "fast",
      system: options.prompt.body,
      user,
      schema,
      maxTokens: REFLECT_LIMITS.maxTokens,
      temperature: 0,
    });
    const keep = new Set<string>(result.value.keep);
    return RunLessonsSchema.parse({
      ...base,
      reflectedBy: "model",
      lessons: base.lessons.filter((_, index) => keep.has(ids[index] ?? "")),
    });
  } catch (error) {
    if (error instanceof RunAbortedError) throw error;
    return base;
  }
}
