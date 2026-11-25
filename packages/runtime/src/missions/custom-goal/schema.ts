import { z } from "zod";

import { type CriticClaim, type KeptClaim } from "../../agent/critic";
import { SourceRecordSchema } from "../../tools/sources";
import { BriefSourceSchema, ClaimSchema, SourceMixSchema, type Claim } from "../company-xray/brief";

export const GOAL_BRIEF_KIND = "goal-brief";
export const GOAL_CHECKPOINT_KIND = "custom-goal.checkpoint";

export const LEVELS = ["low", "medium", "high"] as const;
export const LevelSchema = z.enum(LEVELS);
export type Level = z.infer<typeof LevelSchema>;

export const FOLLOW_UP_MISSIONS = [
  "company-xray",
  "automation-audit",
  "build-agent",
  "repo-xray",
  "ship-a-pr",
] as const;
export const FollowUpMissionSchema = z.enum(FOLLOW_UP_MISSIONS);
export type FollowUpMission = z.infer<typeof FollowUpMissionSchema>;

export const RANK_FORMULA =
  "score = impact (high 3, medium 2, low 1) ÷ effort (low 1, medium 2, high 3); ties keep the drafted order";

const LEVEL_WEIGHT: Record<Level, number> = { low: 1, medium: 2, high: 3 };

const lowerLevel = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
  LevelSchema,
);
const optionalMission = z.preprocess(
  (value) =>
    typeof value === "string" && FOLLOW_UP_MISSIONS.includes(value as FollowUpMission)
      ? value
      : null,
  FollowUpMissionSchema.nullable(),
);

export const WorkstreamSchema = z.object({
  name: z.string().trim().min(1).max(80),
  findings: z.array(ClaimSchema).min(1).max(8),
});
export type Workstream = z.infer<typeof WorkstreamSchema>;

export const ActionDraftSchema = z.object({
  title: z.string().trim().min(1).max(160),
  owner: z.string().trim().min(1).max(60),
  effort: lowerLevel,
  impact: lowerLevel,
  mission: optionalMission.default(null),
  basis: ClaimSchema,
});

export const ActionSchema = z.object({
  rank: z.number().int().min(1),
  score: z.number().min(0),
  title: z.string().trim().min(1).max(160),
  owner: z.string().trim().min(1).max(60),
  effort: LevelSchema,
  impact: LevelSchema,
  mission: FollowUpMissionSchema.nullable(),
  basis: ClaimSchema,
});
export type GoalAction = z.infer<typeof ActionSchema>;

export const GoalSynthesisOutputSchema = z.object({
  objective: z.string().trim().min(1).max(400),
  workstreams: z.array(z.unknown()).max(8).default([]),
  actions: z.array(z.unknown()).max(12).default([]),
  risks: z.array(z.unknown()).max(8).default([]),
  openQuestions: z.array(z.unknown()).max(8).default([]),
});
export type GoalSynthesisOutput = z.infer<typeof GoalSynthesisOutputSchema>;

export interface GoalSections {
  workstreams: Workstream[];
  actions: GoalAction[];
  risks: Claim[];
  openQuestions: string[];
}

export const GoalCompanySchema = z.object({
  name: z.string().trim().min(1).max(200),
  url: z.url(),
  resolvedBy: z.enum(["input", "domain", "wikidata"]),
  entity: z
    .string()
    .regex(/^Q\d+$/)
    .optional(),
});
export type GoalCompany = z.infer<typeof GoalCompanySchema>;

export const GoalCheckpointSchema = z.object({
  company: GoalCompanySchema.nullable().optional(),
  discoveries: z
    .object({
      names: z.array(z.string().max(300)).max(20),
      githubOrgs: z.array(z.string().max(100)).max(20),
      feeds: z.array(z.string().max(2_000)).max(20),
      unfetched: z.array(z.string().max(2_000)).max(500),
    })
    .optional(),
  documents: z
    .array(
      z.object({
        record: SourceRecordSchema,
        text: z.string(),
        hiddenText: z.array(z.string()).max(200),
      }),
    )
    .max(200),
});
export type GoalCheckpoint = z.infer<typeof GoalCheckpointSchema>;

export const GoalPartialSchema = z.object({
  reason: z.string().min(1).max(300),
  skippedSteps: z.array(z.string().min(1).max(60)).max(12),
});

const GoalBriefBase = z.object({
  missionId: z.literal("custom-goal"),
  goal: z.string().min(1).max(900),
  objective: z.string().min(1).max(400),
  company: GoalCompanySchema.nullable(),
  sources: z.array(BriefSourceSchema).max(200),
  sourceMix: SourceMixSchema,
  rankFormula: z.string(),
  generatedAt: z.iso.datetime({ offset: true }),
  promptVersions: z.array(z.string()).max(20),
  partial: GoalPartialSchema.optional(),
});

export const GoalBriefSchema = GoalBriefBase.extend({
  status: z.literal("complete"),
  workstreams: z.array(WorkstreamSchema).max(8),
  actions: z.array(ActionSchema).max(8),
  risks: z.array(ClaimSchema).max(8),
  openQuestions: z.array(z.string().trim().min(1).max(300)).max(8),
});
export type GoalBrief = z.infer<typeof GoalBriefSchema>;

export const GoalBriefDraftSchema = z.union([
  GoalBriefSchema,
  GoalBriefBase.extend({
    status: z.literal("draft"),
    workstreams: z.array(WorkstreamSchema).max(8).default([]),
    actions: z.array(ActionSchema).max(8).default([]),
    risks: z.array(ClaimSchema).max(8).default([]),
    openQuestions: z.array(z.string().trim().min(1).max(300)).max(8).default([]),
  }),
]);
export type GoalBriefDraft = z.infer<typeof GoalBriefDraftSchema>;

export function actionScore(impact: Level, effort: Level): number {
  return Math.round((LEVEL_WEIGHT[impact] / LEVEL_WEIGHT[effort]) * 100) / 100;
}

export function rankActions(actions: readonly z.infer<typeof ActionDraftSchema>[]): GoalAction[] {
  return actions
    .map((action, index) => ({ action, index, score: actionScore(action.impact, action.effort) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 8)
    .map(({ action, score }, index) => ({ ...action, rank: index + 1, score }));
}

export interface NormalisedGoal {
  objective: string;
  sections: GoalSections;
  discarded: number;
  dropped: { where: string; claim: Claim }[];
}

function cited(claim: Claim, evidence: ReadonlySet<string>): Claim | null {
  const citations = claim.citations.filter((id) => evidence.has(id));
  return citations.length === 0 ? null : { ...claim, citations };
}

export function normaliseGoalSynthesis(
  raw: GoalSynthesisOutput,
  evidence: ReadonlySet<string>,
): NormalisedGoal {
  let discarded = 0;
  const dropped: NormalisedGoal["dropped"] = [];
  const keep = (claim: Claim, where: string): Claim | null => {
    const kept = cited(claim, evidence);
    if (kept === null) dropped.push({ where, claim });
    return kept;
  };
  const parseAll = <T>(items: readonly unknown[], schema: z.ZodType<T>): T[] =>
    items.flatMap((item) => {
      const parsed = schema.safeParse(item);
      if (!parsed.success) discarded += 1;
      return parsed.success ? [parsed.data] : [];
    });
  const looseWorkstream = z.object({
    name: z.string().trim().min(1).max(80),
    findings: z.array(z.unknown()).max(12),
  });
  const workstreams = parseAll(raw.workstreams, looseWorkstream).flatMap((stream) => {
    const findings = parseAll(stream.findings, ClaimSchema)
      .flatMap((claim) => keep(claim, stream.name) ?? [])
      .slice(0, 8);
    return findings.length === 0 ? [] : [{ name: stream.name, findings }];
  });
  const actions = rankActions(
    parseAll(raw.actions, ActionDraftSchema).flatMap((action) => {
      const basis = keep(action.basis, `action: ${action.title}`);
      return basis === null ? [] : [{ ...action, basis }];
    }),
  );
  const risks = parseAll(raw.risks, ClaimSchema)
    .flatMap((claim) => keep(claim, "risks") ?? [])
    .slice(0, 8);
  const openQuestions = parseAll(raw.openQuestions, z.string().trim().min(1).max(300)).slice(0, 8);
  return {
    objective: raw.objective,
    sections: { workstreams: workstreams.slice(0, 8), actions, risks, openQuestions },
    discarded,
    dropped,
  };
}

export function goalCitedSources(sections: GoalSections): Set<string> {
  return new Set(listGoalClaims(sections).flatMap((claim) => claim.citations));
}

const toCritic = (id: string, claim: Claim): CriticClaim => ({
  id,
  text: claim.text,
  citations: [...claim.citations],
});

export function listGoalClaims(sections: GoalSections): CriticClaim[] {
  return [
    ...sections.workstreams.flatMap((stream, s) =>
      stream.findings.map((claim, c) => toCritic(`workstream.${s}.${c}`, claim)),
    ),
    ...sections.actions.map((action, a) => toCritic(`action.${a}`, action.basis)),
    ...sections.risks.map((claim, r) => toCritic(`risk.${r}`, claim)),
  ];
}

export function applyGoalClaims(
  sections: GoalSections,
  kept: ReadonlyMap<string, KeptClaim>,
): GoalSections {
  const pick = (id: string): Claim | undefined => {
    const claim = kept.get(id);
    if (claim === undefined) return undefined;
    return {
      text: claim.text,
      citations: claim.citations,
      ...(claim.support === "supported" ? {} : { support: claim.support }),
    };
  };
  const workstreams = sections.workstreams.flatMap((stream, s) => {
    const findings = stream.findings.flatMap((_, c) => pick(`workstream.${s}.${c}`) ?? []);
    return findings.length === 0 ? [] : [{ name: stream.name, findings }];
  });
  const actions = sections.actions
    .flatMap((action, a) => {
      const basis = pick(`action.${a}`);
      return basis === undefined ? [] : [{ ...action, basis }];
    })
    .map((action, index) => ({ ...action, rank: index + 1 }));
  const risks = sections.risks.flatMap((_, r) => pick(`risk.${r}`) ?? []);
  return { workstreams, actions, risks, openQuestions: sections.openQuestions };
}
