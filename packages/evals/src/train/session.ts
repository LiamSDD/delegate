import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { EvolutionKindSchema, type EvolutionKind } from "../evolve/log";
import { StoredProposalSchema } from "../evolve/propose";
import { EVAL_MISSIONS, type EvalMission } from "../results";

export const SESSION_VERSION = 1;

export const SessionArgsSchema = z.strictObject({
  missions: z.array(z.enum(EVAL_MISSIONS)).min(1),
  rounds: z.number().int().positive(),
  trials: z.number().int().min(2),
  cases: z.array(z.string().min(1)).optional(),
  audience: z.enum(["public-demo", "owner"]),
  threshold: z.number().min(0).max(1).optional(),
});
export type SessionArgs = z.infer<typeof SessionArgsSchema>;

export const SessionSchema = z.strictObject({
  version: z.literal(SESSION_VERSION),
  key: z.string().regex(/^[0-9a-f]{12}$/),
  createdAt: z.iso.datetime({ offset: true }),
  args: SessionArgsSchema,
  baseRound: z.record(z.string(), z.number().int().nonnegative()),
  steps: z.record(z.string(), z.strictObject({ recordId: z.string().min(1) })),
  proposals: z.record(
    z.string(),
    z.strictObject({
      baseline: z.string().regex(/^[0-9a-f]{16}$/),
      proposal: StoredProposalSchema,
      nextPromptVersion: z.number().int().positive().optional(),
    }),
  ),
});
export type Session = z.infer<typeof SessionSchema>;

export function sessionKey(args: SessionArgs): string {
  const canonical = SessionArgsSchema.parse({
    ...args,
    ...(args.cases === undefined ? {} : { cases: [...args.cases].sort() }),
  });
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 12);
}

export function stepKey(mission: EvalMission, round: number, kind: EvolutionKind): string {
  return `${mission}|${round}|${EvolutionKindSchema.parse(kind)}`;
}

export function sessionPath(trainingDir: string, key: string): string {
  return join(trainingDir, "pending", `session-${key}.json`);
}

export function loadSession(trainingDir: string, args: SessionArgs): Session | null {
  const path = sessionPath(trainingDir, sessionKey(args));
  if (!existsSync(path)) return null;
  try {
    const parsed = SessionSchema.safeParse(JSON.parse(readFileSync(path, "utf8")) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function saveSession(trainingDir: string, session: Session): void {
  mkdirSync(join(trainingDir, "pending"), { recursive: true });
  writeFileSync(
    sessionPath(trainingDir, session.key),
    `${JSON.stringify(SessionSchema.parse(session), null, 2)}\n`,
  );
}

export function clearSession(trainingDir: string, session: Session): void {
  rmSync(sessionPath(trainingDir, session.key), { force: true });
}
