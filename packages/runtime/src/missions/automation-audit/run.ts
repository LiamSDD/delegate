import { CAPABILITIES } from "@delegate/policy";
import { z } from "zod";

import { type RunContext } from "../../agent/context";
import {
  formatAccuracy,
  runCriticSafely,
  type ClaimSupport,
  type CriticClaim,
} from "../../agent/critic";
import {
  runPlannedMission,
  stepFailure,
  type PlannedMission,
  type PlannedRunOptions,
} from "../../agent/mission-runner";
import { missionClock } from "../../agent/pacing";
import { StructuredOutputError, callStructured } from "../../agent/structured";
import {
  FatalStepError,
  inputArtifacts,
  inputFindings,
  type StepExecutor,
  type SubAgentResult,
} from "../../agent/subagent";
import { NoModelAvailableError } from "../../router";
import { ModelStreamError, withQualityNote, type ModelCallResult } from "../../agent/model-call";
import { type PromptFile } from "../../prompts";
import { type Fetcher } from "../../tools/fetch";
import { NEXT_ACTIONS_KIND, type NextActions } from "../next-actions";
import {
  createResearchKit,
  factLine,
  factToFinding,
  findingsToFacts,
  plural,
  quotesBySource,
  roundRobin,
  type TopicFact,
} from "../shared/research";
import { checkSpecificity } from "./genericity";
import { type AutomationAuditInput } from "./input";
import { AUDIT_LENSES, type AuditLens } from "./lenses";
import { AUDIT_PLANNING_HINTS, AUDIT_STEP_IDS, auditPlan } from "./plan";
import { AUDIT_FORMULA, estimateRoi } from "./roi";
import {
  AUTOMATION_AUDIT_KIND,
  AUTOMATION_CANDIDATES_KIND,
  AutomationAuditSchema,
  DIFFICULTIES,
  MAX_OPPORTUNITIES,
  MIN_OPPORTUNITIES,
  type AuditEvidence,
  type AutomationAudit,
  type Opportunity,
  type VerificationStatus,
} from "./schema";
import { AUDIT_GAP_TOPICS, AUDIT_READER_TASK } from "./task";

export interface AutomationAuditPrompts {
  reader: PromptFile;
  researcher: PromptFile;
  planner: PromptFile;
  critic: PromptFile;
  editor: PromptFile;
  analyst: PromptFile;
  auditEditor: PromptFile;
}

export interface AutomationAuditDependencies {
  ctx: RunContext;
  input: AutomationAuditInput;
  fetcher: Fetcher;
  prompts: AutomationAuditPrompts;
  run?: Omit<PlannedRunOptions, "plannerPrompt">;
}

export const AUDIT_LIMITS = {
  crawlPages: 12,
  targetMs: 150_000,
  gapFillEndsAtMs: 70_000,
  analystFacts: 90,
  analystMaxTokens: 4_000,
  editorMaxTokens: 1_200,
  candidatesPerLens: 4,
  candidatesSingleLens: 8,
  titleSimilarity: 0.6,
} as const;

export const MAX_HOURS_PER_PERSON = 80;

export const ROI_BOUNDS = {
  frequencyPerMonth: [1, 400],
  minutesPerTask: [1, 240],
  peopleInvolved: [1, 50],
  adoptionRate: [0.1, 0.7],
  hourlyCostEur: [25, 90],
} as const;

export const ROI_DEFAULTS = {
  frequencyPerMonth: 10,
  minutesPerTask: 15,
  peopleInvolved: 1,
  adoptionRate: 0.3,
} as const;

const looseNumber = z.preprocess(
  (value) => (typeof value === "string" ? Number.parseFloat(value.replace(/[^\d.-]/g, "")) : value),
  z.number().optional().catch(undefined),
);
const looseStrings = z.preprocess(
  (value) => (typeof value === "string" ? [value] : value),
  z.array(z.string()).default([]).catch([]),
);

const CandidateDraftSchema = z.object({
  title: z.string().trim().min(1),
  workflow: z.string().trim().min(1),
  automation: z.string().trim().min(1),
  frequencyPerMonth: looseNumber,
  minutesPerTask: looseNumber,
  peopleInvolved: looseNumber,
  adoptionRate: looseNumber,
  hourlyCostEur: looseNumber,
  difficulty: z.enum(DIFFICULTIES).catch("medium"),
  risks: looseStrings,
  integrations: looseStrings,
  firstStep: z.string().trim().min(1).catch("Map the current process with the team that owns it."),
  evidence: z
    .array(
      z.object({
        text: z.string().trim().min(1),
        citations: z.preprocess(
          (value) => (typeof value === "string" ? value.split(/[\s,;]+/) : value),
          z.array(z.string()).default([]),
        ),
      }),
    )
    .default([]),
  assumptions: looseStrings,
});
type CandidateDraft = z.infer<typeof CandidateDraftSchema>;

const AnalystOutputSchema = z.object({
  candidates: z.array(z.unknown()).transform((items) =>
    items.flatMap((item) => {
      const parsed = CandidateDraftSchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    }),
  ),
});

const EditorOutputSchema = z.object({
  company: z.string().trim().min(1).max(120).optional(),
  picks: z.array(z.string()),
  notes: z.string().optional(),
});

export interface Candidate extends Omit<Opportunity, "id"> {
  candidateId: string;
}

interface Rejected {
  title: string;
  reasons: string[];
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function bounded(
  value: number | undefined,
  key: keyof typeof ROI_BOUNDS,
  fallback: number,
  label: string,
  notes: string[],
): number {
  const [min, max] = ROI_BOUNDS[key];
  if (value === undefined) {
    notes.push(`${label}: no estimate given, conservative default ${fallback} used.`);
    return fallback;
  }
  if (value < min || value > max) {
    const clamped = Math.min(max, Math.max(min, value));
    notes.push(
      `${label}: ${value} was outside the conservative range ${min}–${max}, clamped to ${clamped}.`,
    );
    return clamped;
  }
  return value;
}

export function normaliseCandidate(
  draft: CandidateDraft,
  lens: AuditLens,
  known: ReadonlySet<string>,
  candidateId: string,
  department: string = lens.department,
): Candidate {
  const notes: string[] = [];
  const evidence: AuditEvidence[] = draft.evidence
    .map((entry) => ({
      text: cut(entry.text, 600),
      citations: [
        ...new Set(
          entry.citations
            .map((citation) => citation.replace(/[[\]()]/g, "").trim())
            .filter((id) => known.has(id)),
        ),
      ].slice(0, 8),
    }))
    .filter((entry) => entry.citations.length > 0)
    .slice(0, 6);
  const values = {
    frequencyPerMonth: bounded(
      draft.frequencyPerMonth,
      "frequencyPerMonth",
      ROI_DEFAULTS.frequencyPerMonth,
      "Frequency per person per month",
      notes,
    ),
    minutesPerTask: bounded(
      draft.minutesPerTask,
      "minutesPerTask",
      ROI_DEFAULTS.minutesPerTask,
      "Minutes per task",
      notes,
    ),
    peopleInvolved: bounded(
      draft.peopleInvolved,
      "peopleInvolved",
      ROI_DEFAULTS.peopleInvolved,
      "People involved",
      notes,
    ),
    adoptionRate: bounded(
      draft.adoptionRate,
      "adoptionRate",
      ROI_DEFAULTS.adoptionRate,
      "Adoption rate",
      notes,
    ),
    hourlyCostEur: bounded(
      draft.hourlyCostEur,
      "hourlyCostEur",
      lens.defaultHourlyCostEur,
      "Hourly cost (EUR)",
      notes,
    ),
  };
  const hoursPerPerson = (values.frequencyPerMonth * values.minutesPerTask) / 60;
  if (hoursPerPerson > MAX_HOURS_PER_PERSON) {
    const capped = Math.max(1, Math.floor((MAX_HOURS_PER_PERSON * 60) / values.minutesPerTask));
    notes.push(
      `Frequency: ${values.frequencyPerMonth} × ${values.minutesPerTask} min would be ${Math.round(hoursPerPerson)} h per person per month; capped at ${capped} so one task takes at most half a full-time role (${MAX_HOURS_PER_PERSON} h).`,
    );
    values.frequencyPerMonth = capped;
  }
  return {
    candidateId,
    title: cut(draft.title, 140),
    department: cut(department, 80),
    workflow: cut(draft.workflow, 900),
    automation: cut(draft.automation, 900),
    ...values,
    difficulty: draft.difficulty,
    risks: draft.risks
      .map((risk) => cut(risk.trim(), 300))
      .filter((risk) => risk !== "")
      .slice(0, 6),
    integrations: draft.integrations
      .map((name) => cut(name.trim(), 80))
      .filter((name) => name !== "")
      .slice(0, 10),
    firstStep: cut(draft.firstStep, 500),
    evidence,
    assumptions: [
      ...draft.assumptions.map((note) => cut(note.trim(), 300)).filter((note) => note !== ""),
      ...notes,
    ].slice(0, 10),
  };
}

export function pickCompanyName(
  names: readonly string[],
  quotes: readonly string[],
  fallback: string,
): string {
  const text = quotes.join("\n").toLowerCase();
  let best: { name: string; count: number } | undefined;
  for (const name of names) {
    const needle = name.toLowerCase();
    const count = needle === "" ? 0 : text.split(needle).length - 1;
    if (best === undefined || count > best.count) best = { name, count };
  }
  return best?.name ?? fallback;
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
}

function similar(a: string, b: string): number {
  const left = words(a);
  const right = words(b);
  const shared = [...left].filter((word) => right.has(word)).length;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : shared / union;
}

export function dedupeCandidates(candidates: readonly Candidate[]): Candidate[] {
  const byValue = [...candidates].sort(
    (a, b) => estimateRoi(b).eurPerMonth - estimateRoi(a).eurPerMonth,
  );
  const kept: Candidate[] = [];
  for (const candidate of byValue)
    if (
      !kept.some((other) => similar(other.title, candidate.title) >= AUDIT_LIMITS.titleSimilarity)
    )
      kept.push(candidate);
  return kept;
}

export function rankOpportunities(candidates: readonly Candidate[]): Opportunity[] {
  return [...candidates]
    .sort((a, b) => estimateRoi(b).eurPerMonth - estimateRoi(a).eurPerMonth)
    .map(({ candidateId: _candidateId, ...rest }, index) => ({ id: `opp-${index + 1}`, ...rest }));
}

function euros(value: number): string {
  return `€${Math.round(value).toLocaleString("en-GB")}`;
}

export function auditSummary(company: string, opportunities: readonly Opportunity[]): string {
  const totals = opportunities.reduce(
    (sum, opportunity) => {
      const estimate = estimateRoi(opportunity);
      return { hours: sum.hours + estimate.hoursPerMonth, eur: sum.eur + estimate.eurPerMonth };
    },
    { hours: 0, eur: 0 },
  );
  const top = opportunities[0];
  return cut(
    `${plural(opportunities.length, "automation opportunity", "automation opportunities")} for ${company}, ranked by estimated value.${top === undefined ? "" : ` Largest: ${top.title} (about ${euros(estimateRoi(top).eurPerMonth)}/month).`} Combined estimate: about ${Math.round(totals.hours)} hours and ${euros(totals.eur)} per month. These are estimates from stated assumptions (${AUDIT_FORMULA}).`,
    1200,
  );
}

function isModelFailure(error: unknown): boolean {
  return (
    error instanceof StructuredOutputError ||
    error instanceof NoModelAvailableError ||
    error instanceof ModelStreamError
  );
}

interface AuditState {
  artifactId: string;
  version: number;
  company: string;
  opportunities: Opportunity[];
  facts: TopicFact[];
  final: boolean;
  verification?: NonNullable<AutomationAudit["verification"]>;
}

export function createAutomationAuditMission(deps: AutomationAuditDependencies): PlannedMission {
  const { ctx, input, prompts } = deps;
  const emit = ctx.emitter.emit.bind(ctx.emitter);
  const runId = ctx.runId;
  const clock = missionClock(ctx, AUDIT_LIMITS.targetMs);
  const kit = createResearchKit({
    ctx,
    missionId: "automation-audit",
    fetcher: deps.fetcher,
    siteUrl: input.url,
    ...(input.focus === undefined ? {} : { focus: input.focus }),
    readerTask: AUDIT_READER_TASK,
    readerPrompt: prompts.reader,
    researcherPrompt: prompts.researcher,
    crawlPages: AUDIT_LIMITS.crawlPages,
    clock,
    gapTopics: (facts) => {
      const topics = new Set(facts.map((fact) => fact.topic));
      return AUDIT_GAP_TOPICS.filter((topic) => !topics.has(topic));
    },
    gapFillDeadlineMs: AUDIT_LIMITS.gapFillEndsAtMs,
    callsAfterGapFill: ["worker", "planner", "fast"],
  });
  const candidates = new Map<string, Candidate[]>();
  let audit: AuditState | undefined;
  const defaultPlan = auditPlan(input);
  const lensCount = defaultPlan.filter((step) =>
    AUDIT_LENSES.some((lens) => lens.stepId === step.id),
  ).length;
  const perLens =
    lensCount <= 1 ? AUDIT_LIMITS.candidatesSingleLens : AUDIT_LIMITS.candidatesPerLens;
  let knownQuotes: string[] = [];
  const companyGuess = () =>
    pickCompanyName(kit.env.discoveries.names, knownQuotes, kit.env.scope.root);

  const sourcesFor = (opportunities: readonly Opportunity[]) => {
    const cited = new Set(
      opportunities.flatMap((opportunity) =>
        opportunity.evidence.flatMap((entry) => entry.citations),
      ),
    );
    return kit
      .documents()
      .filter((document) => cited.has(document.record.sourceId))
      .map((document) => document.record);
  };
  const content = (state: AuditState): AutomationAudit =>
    AutomationAuditSchema.parse({
      company: state.company,
      summary: auditSummary(state.company, state.opportunities),
      opportunities: state.opportunities,
      sources: sourcesFor(state.opportunities),
      formula: AUDIT_FORMULA,
      ...(state.verification === undefined ? {} : { verification: state.verification }),
    });

  const analyst = (lens: AuditLens): StepExecutor => ({
    id: lens.stepId,
    role: "analyst",
    modelRole: "worker",
    capabilities: [],
    needs: [AUDIT_STEP_IDS.read],
    description: `Analyst for the ${lens.department} lens (${lens.focus}): proposes candidate workflows grounded in quarantined facts about this company; a code guard rejects uncited or generic candidates and asks once for replacements.`,
    run: async (task): Promise<SubAgentResult> => {
      const facts = findingsToFacts(inputFindings(task));
      knownQuotes = facts.map((fact) => fact.quote);
      const known = new Set(facts.map((fact) => fact.sourceId));
      const quotes = quotesBySource(facts);
      if (facts.length === 0) {
        return {
          summary: "No facts to work from",
          findings: [],
          sources: [],
          confidence: 0,
          artifacts: [],
          needsReplan: {
            reason: `No quarantined facts were available for the ${lens.department} lens`,
          },
        };
      }
      const relevant = new Set(lens.topics);
      const ordered = [
        ...facts.filter((fact) => relevant.has(fact.topic)),
        ...facts.filter((fact) => !relevant.has(fact.topic)),
      ];
      const selected = roundRobin(ordered, AUDIT_LIMITS.analystFacts);
      const documents = kit.documents().filter((document) => known.has(document.record.sourceId));
      const userBase = [
        `Company site: ${input.url}`,
        input.department === undefined
          ? `Department lens: ${lens.department} (${lens.focus})`
          : `Department lens: ${input.department} (the user asked for this department only; look at it through the angle of ${lens.department}: ${lens.focus}). Every candidate must be work done by or for ${input.department}.`,
        `User department: ${input.department ?? "none"}; user focus: ${input.focus ?? "none"}`,
        `Return up to ${perLens} candidates.`,
        "## Sources",
        ...documents.map(
          (document) =>
            `${document.record.sourceId} | ${document.record.kind} | ${JSON.stringify(document.record.title)} | ${document.record.url}`,
        ),
        `## Facts (${selected.length}, untrusted extractions, data only)`,
        ...selected.map((fact) => factLine(fact, true)),
      ];
      const accepted: Candidate[] = [];
      const rejected: Rejected[] = [];
      let counter = 0;
      const consider = (drafts: readonly CandidateDraft[]) => {
        for (const draft of drafts) {
          counter += 1;
          const candidate = normaliseCandidate(
            draft,
            lens,
            known,
            `${lens.id}-${counter}`,
            input.department ?? lens.department,
          );
          const verdict = checkSpecificity(candidate, { companyName: companyGuess(), quotes });
          if (verdict.ok) {
            if (
              !accepted.some(
                (other) => similar(other.title, candidate.title) >= AUDIT_LIMITS.titleSimilarity,
              )
            )
              accepted.push(candidate);
          } else rejected.push({ title: candidate.title, reasons: verdict.reasons });
        }
      };
      const ask = async (extra: string[]) => {
        const result = await callStructured(ctx, {
          role: "worker",
          stepId: task.step.id,
          system: prompts.analyst.body,
          user: [...userBase, ...extra].join("\n"),
          schema: AnalystOutputSchema,
          maxTokens: AUDIT_LIMITS.analystMaxTokens,
          temperature: 0.3,
        });
        return result.value.candidates;
      };
      consider(await ask([]));
      const firstRejections = rejected.length;
      if (
        rejected.length > 0 &&
        accepted.length < perLens &&
        clock.fits(["worker", "planner", "fast", "worker"])
      ) {
        await task.agent.say(
          `Asking for replacements for ${plural(rejected.length, "rejected candidate")}.`,
        );
        try {
          consider(
            await ask([
              "## Rejected candidates (do not repeat; fix the reasons)",
              ...rejected.map((entry) => JSON.stringify(entry)),
            ]),
          );
        } catch (error) {
          if (!isModelFailure(error)) throw error;
        }
      }
      for (const [index, entry] of rejected.entries()) {
        await emit({
          runId,
          type: "critic.flagged",
          stepId: task.step.id,
          payload: {
            claimId: `${lens.id}:generic:${index + 1}`,
            claim: cut(entry.title, 300),
            reason: cut(`Rejected candidate: ${entry.reasons.join("; ")}`, 500),
            severity: "info",
            category: entry.reasons.some((reason) => reason.startsWith("cites no"))
              ? "uncited"
              : "claim",
          },
        });
      }
      const kept = accepted.slice(0, perLens);
      const artifactId = crypto.randomUUID();
      candidates.set(artifactId, kept);
      await emit({
        runId,
        type: "artifact.created",
        stepId: task.step.id,
        payload: {
          artifactId,
          kind: AUTOMATION_CANDIDATES_KIND,
          title: `${lens.department} candidates`,
          version: 1,
          content: { lens: lens.id, department: lens.department, candidates: kept, rejected },
        },
      });
      await task.agent.say(
        `${plural(kept.length, "specific candidate")} for ${lens.department}; ${rejected.length} rejected by the genericity guard${firstRejections < rejected.length ? " (including replacements)" : ""}.`,
      );
      return {
        summary: `${plural(kept.length, "candidate")} (${rejected.length} rejected as generic or uncited)`,
        findings: kept.map((candidate) => ({
          text: cut(`${candidate.title}: ${candidate.workflow}`, 600),
          citations: [...new Set(candidate.evidence.flatMap((entry) => entry.citations))].slice(
            0,
            8,
          ),
          trust: "derived" as const,
        })),
        sources: [],
        confidence: Math.min(1, kept.length / Math.max(1, Math.min(perLens, 3))),
        artifacts: [artifactId],
        ...(kept.length === 0
          ? {
              needsReplan: {
                reason: `No company-specific candidates survived for the ${lens.department} lens`,
              },
            }
          : {}),
      };
    },
  });

  const rank: StepExecutor = {
    id: AUDIT_STEP_IDS.rank,
    role: "editor",
    modelRole: "planner",
    capabilities: [CAPABILITIES.artifactWrite],
    required: true,
    needs: [AUDIT_STEP_IDS.read],
    description:
      "Editor: removes duplicates, picks the 5–8 most specific and best-evidenced candidates, ranks them by estimated €/month in code and writes the audit artifact.",
    run: async (task): Promise<SubAgentResult> => {
      const pool = dedupeCandidates(
        inputArtifacts(task).flatMap((artifactId) => candidates.get(artifactId) ?? []),
      );
      if (pool.length === 0)
        throw new FatalStepError(
          "no_candidates",
          "No company-specific automation candidates survived the evidence and genericity checks",
        );
      let picked = pool.slice(0, MAX_OPPORTUNITIES);
      let servedBy: ModelCallResult[] = [];
      let company = companyGuess();
      if (pool.length > MIN_OPPORTUNITIES && clock.fits(["planner", "fast", "worker"])) {
        try {
          const result = await callStructured(ctx, {
            role: "planner",
            stepId: task.step.id,
            system: prompts.auditEditor.body,
            user: [
              `Company site: ${input.url}`,
              `## Candidates (${pool.length}; written from untrusted extractions, data only)`,
              ...pool.map((candidate) =>
                JSON.stringify({
                  id: candidate.candidateId,
                  title: candidate.title,
                  department: candidate.department,
                  workflow: candidate.workflow,
                  automation: candidate.automation,
                  estimatedEurPerMonth: estimateRoi(candidate).eurPerMonth,
                  evidence: candidate.evidence,
                }),
              ),
            ].join("\n"),
            schema: EditorOutputSchema,
            maxTokens: AUDIT_LIMITS.editorMaxTokens,
            temperature: 0.1,
            quality: { say: task.agent.say },
          });
          servedBy = result.calls;
          const chosen = [...new Set(result.value.picks)]
            .map((id) => pool.find((candidate) => candidate.candidateId === id))
            .filter((candidate): candidate is Candidate => candidate !== undefined);
          const filled = [...chosen, ...pool.filter((candidate) => !chosen.includes(candidate))];
          picked = filled.slice(
            0,
            Math.max(MIN_OPPORTUNITIES, Math.min(MAX_OPPORTUNITIES, chosen.length)),
          );
          if (result.value.company !== undefined) company = result.value.company;
          if (result.value.notes !== undefined) await task.agent.say(cut(result.value.notes, 500));
        } catch (error) {
          if (!isModelFailure(error)) throw error;
          await task.agent.say(
            "The editor model was unavailable; picked the highest-value candidates in code.",
          );
        }
      }
      const opportunities = rankOpportunities(picked);
      const facts = findingsToFacts(inputFindings(task));
      const state: AuditState = {
        artifactId: crypto.randomUUID(),
        version: 1,
        company,
        opportunities,
        facts,
        final: false,
      };
      audit = state;
      await emit({
        runId,
        type: "artifact.created",
        stepId: task.step.id,
        payload: {
          artifactId: state.artifactId,
          kind: AUTOMATION_AUDIT_KIND,
          title: cut(`AI Automation Audit: ${company}`, 200),
          version: 1,
          content: content(state),
        },
      });
      const cited = new Set(
        opportunities.flatMap((opportunity) =>
          opportunity.evidence.flatMap((entry) => entry.citations),
        ),
      );
      return {
        summary: withQualityNote(
          `Picked ${plural(opportunities.length, "opportunity", "opportunities")} from ${plural(pool.length, "candidate")}, ranked by estimated €/month`,
          servedBy,
        ),
        findings: facts.filter((fact) => cited.has(fact.sourceId)).map(factToFinding),
        sources: sourcesFor(opportunities),
        confidence: Math.min(1, opportunities.length / MIN_OPPORTUNITIES),
        artifacts: [state.artifactId],
      };
    },
  };

  const critic: StepExecutor = {
    id: AUDIT_STEP_IDS.critic,
    role: "critic",
    modelRole: "fast",
    capabilities: [CAPABILITIES.artifactWrite],
    required: true,
    needs: [AUDIT_STEP_IDS.rank],
    description:
      "Checks every opportunity's workflow and evidence claims against their cited quotes, sends unsupported ones to an editor sub-agent (at most two loops), drops opportunities that lose their evidence and reports citation accuracy.",
    run: async (task): Promise<SubAgentResult> => {
      const state = audit;
      if (state === undefined || !inputArtifacts(task).includes(state.artifactId))
        throw new Error("The critic has no drafted audit to check");
      const facts = findingsToFacts(inputFindings(task));
      const quotes = quotesBySource(facts.length > 0 ? facts : state.facts);
      const claims: CriticClaim[] = state.opportunities.flatMap((opportunity) => [
        {
          id: `${opportunity.id}.workflow`,
          text: opportunity.workflow,
          citations: [...new Set(opportunity.evidence.flatMap((entry) => entry.citations))],
        },
        ...opportunity.evidence.map((entry, index) => ({
          id: `${opportunity.id}.evidence.${index}`,
          text: entry.text,
          citations: [...entry.citations],
        })),
      ]);
      const outcome = await runCriticSafely(ctx, claims, {
        stepId: task.step.id,
        agent: task.agent,
        spawnEditor: () => task.spawn("editor", "worker"),
        prompts: { critic: prompts.critic, editor: prompts.editor },
        deliverable: `AI Automation Audit for ${state.company}: each workflow describes what people at the company do today`,
        evidence: quotes,
        canFix: () => clock.fits(["worker", "fast"]),
      });
      const supportOf = (support: ClaimSupport) => (support === "supported" ? {} : { support });
      const dropped: string[] = [];
      const survivors = state.opportunities.flatMap((opportunity): Opportunity[] => {
        const workflow = outcome.kept.get(`${opportunity.id}.workflow`);
        const evidence = opportunity.evidence.flatMap((_, index) => {
          const kept = outcome.kept.get(`${opportunity.id}.evidence.${index}`);
          return kept === undefined
            ? []
            : [{ text: kept.text, citations: kept.citations, ...supportOf(kept.support) }];
        });
        if (workflow === undefined || evidence.length === 0) {
          dropped.push(opportunity.title);
          return [];
        }
        const next = { ...opportunity, workflow: workflow.text, evidence };
        if (!checkSpecificity(next, { companyName: state.company, quotes }).ok) {
          dropped.push(opportunity.title);
          return [];
        }
        const supported = evidence.filter((entry) => entry.support === undefined).length;
        const verification: VerificationStatus =
          supported === evidence.length && workflow.support === "supported"
            ? "verified"
            : supported > 0
              ? "partially_verified"
              : "unverified";
        return [{ ...next, verification }];
      });
      const accuracy = formatAccuracy(outcome.report);
      if (survivors.length === 0) {
        state.opportunities = state.opportunities.map((opportunity) => ({
          ...opportunity,
          evidence: opportunity.evidence.map((entry) => ({
            ...entry,
            support: "unverified" as const,
          })),
          verification: "unverified" as const,
        }));
        state.verification = {
          status: "unverified",
          citationAccuracy: outcome.report.citationAccuracy,
          note: "The critic could not confirm any opportunity against its cited quotes; this is the editor's draft, unverified.",
        };
        await emit({
          runId,
          type: "critic.flagged",
          stepId: task.step.id,
          payload: {
            claimId: "audit:unverified",
            claim: "No opportunity could be verified against its cited quotes",
            reason:
              "Delivering the editor's draft clearly marked unverified instead of an empty audit",
            severity: "error",
            category: "claim",
          },
        });
      } else {
        state.opportunities = survivors;
        const statuses = new Set(survivors.map((opportunity) => opportunity.verification));
        state.verification = {
          status:
            statuses.size === 1 && statuses.has("verified")
              ? "verified"
              : statuses.has("verified") || statuses.has("partially_verified")
                ? "partially_verified"
                : "unverified",
          citationAccuracy: outcome.report.citationAccuracy,
        };
      }
      state.version += 1;
      await emit({
        runId,
        type: "artifact.updated",
        stepId: task.step.id,
        payload: { artifactId: state.artifactId, version: state.version, content: content(state) },
      });
      state.final = true;
      await task.agent.say(
        `Checked ${plural(outcome.report.claimsChecked, "claim")}: ${accuracy}.${dropped.length === 0 ? "" : ` Dropped ${plural(dropped.length, "opportunity", "opportunities")} whose workflow was contradicted or lost all evidence: ${dropped.join("; ")}.`}`,
      );
      const kept = state.opportunities.length;
      if (kept < MIN_OPPORTUNITIES)
        await emit({
          runId,
          type: "critic.flagged",
          stepId: task.step.id,
          payload: {
            claimId: "audit:count",
            claim: `Only ${plural(kept, "opportunity", "opportunities")} are specific and supported`,
            reason: `Fewer than ${MIN_OPPORTUNITIES}: the public evidence did not support more company-specific workflows, so none were padded in`,
            severity: "info",
            category: "claim",
          },
        });
      return {
        summary: `Audit ${state.verification.status.replace("_", " ")}: ${accuracy}; ${plural(kept, "opportunity", "opportunities")} kept`,
        findings: [],
        sources: [],
        confidence: outcome.report.citationAccuracy ?? 0.3,
        artifacts: [state.artifactId],
        critic: outcome.report,
      };
    },
  };

  const lenses = AUDIT_LENSES.map(analyst);
  return {
    planner: {
      missionId: "automation-audit",
      title: "AI Automation Audit",
      objective:
        "5–8 workflows specific to this company that AI agents could automate, each with evidence about this company, an explicit ROI model (frequency × minutes × people × adoption → hours and € per month) with stated assumptions, difficulty, risks, integrations and a first step. Generic answers count as failures.",
      input,
      planningHints: AUDIT_PLANNING_HINTS,
      executors: [...kit.executors, ...lenses, rank, critic],
      allowedCapabilities: [CAPABILITIES.webFetch, CAPABILITIES.artifactWrite],
    },
    defaultPlan,
    clock,
    finish: async (outcome) => {
      const state = audit;
      if (state === undefined)
        return { status: "failed", error: stepFailure(outcome, AUDIT_STEP_IDS.rank) };
      if (!state.final) {
        await emit({
          runId,
          type: "critic.flagged",
          payload: {
            claimId: "critic:skipped",
            claim: "The audit's claims were not checked against their quotes",
            reason:
              "The critic step did not complete, so the audit is published with code-enforced citations and genericity checks only",
            severity: "info",
            category: "claim",
          },
        });
        state.opportunities = state.opportunities.map((opportunity) => ({
          ...opportunity,
          evidence: opportunity.evidence.map((entry) => ({
            ...entry,
            support: "unverified" as const,
          })),
          verification: "unverified" as const,
        }));
        state.verification = {
          status: "unverified",
          citationAccuracy: null,
          note: "The critic did not run to completion; claims are unverified.",
        };
        state.version += 1;
        await emit({
          runId,
          type: "artifact.updated",
          payload: {
            artifactId: state.artifactId,
            version: state.version,
            content: content(state),
          },
        });
      }
      const actions: NextActions = {
        missionId: "automation-audit",
        actions: state.opportunities.map((opportunity) => ({
          id: `build-${opportunity.id}`,
          label: "Build it",
          description: cut(
            `Turn "${opportunity.title}" into a cited assistant trained on the company's own website, with its own eval set and gaps report.`,
            300,
          ),
          missionId: "build-agent",
          input: {
            url: input.url,
            goal: opportunity.automation,
            name: cut(opportunity.title, 80),
            opportunityId: opportunity.id,
            fromAuditRunId: runId,
          },
          available: true,
          opportunityId: opportunity.id,
        })),
      };
      await emit({
        runId,
        type: "artifact.created",
        payload: {
          artifactId: crypto.randomUUID(),
          kind: NEXT_ACTIONS_KIND,
          title: "Next actions",
          version: 1,
          content: actions,
        },
      });
      const report = outcome.results.get(AUDIT_STEP_IDS.critic)?.critic;
      return {
        status: "completed",
        summary:
          `${auditSummary(state.company, state.opportunities)}${report === undefined ? "" : ` Critic: ${formatAccuracy(report)}.`}`.slice(
            0,
            2000,
          ),
      };
    },
  };
}

export async function runAutomationAudit(
  deps: AutomationAuditDependencies,
): Promise<"completed" | "failed"> {
  return runPlannedMission(deps.ctx, createAutomationAuditMission(deps), {
    plannerPrompt: deps.prompts.planner,
    ...deps.run,
  });
}
