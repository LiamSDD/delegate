import { CAPABILITIES } from "@delegate/policy";

import { type RunContext } from "../../agent/context";
import { formatAccuracy, runCriticSafely, unverifiedOutcome } from "../../agent/critic";
import {
  runPlannedMission,
  stepFailure,
  type PlannedMission,
  type PlannedRunOptions,
} from "../../agent/mission-runner";
import { missionClock } from "../../agent/pacing";
import {
  inputArtifacts,
  inputFindings,
  type StepExecutor,
  type SubAgentResult,
} from "../../agent/subagent";
import { withQualityNote, type ModelCallResult } from "../../agent/model-call";
import { callStructured } from "../../agent/structured";
import {
  mentionsTarget,
  specificityScore,
  type SpecificityContext,
  type SpecificityTarget,
} from "../../agent/specificity";
import { type ResearchReport, type SpecificityReport } from "../../events";
import { type PromptFile } from "../../prompts";
import { COMPANY_PROFILE } from "../../crawl/priority";
import { type Fetcher } from "../../tools/fetch";
import { type SourceDocument } from "../../tools/sources";
import { NEXT_ACTIONS_KIND, type NextActions } from "../next-actions";
import {
  createResearchKit,
  describeMix,
  factLine,
  factToFinding,
  findingsToFacts,
  plural,
  quotesBySource,
  roundRobin,
  sourceMix,
  type TopicFact,
} from "../shared/research";
import { runDeepResearch, type SectionDraft } from "../shared/deep-research";
import {
  CompanyXrayBriefSchema,
  CompanyXrayDraftOutputSchema,
  SECTION_KEYS,
  SECTION_TITLES,
  citedSourceIds,
  dropUnsupportedDates,
  enforceCitations,
  normaliseSynthesis,
  type BriefSource,
  type Claim,
  type CompanyXrayBriefDraft,
  type CompanyXraySections,
} from "./brief";
import { applyBriefClaims, dropGenericBriefClaims, listBriefClaims } from "./claims";
import { type CompanyXrayInput } from "./input";
import { XRAY_PLAN, XRAY_PLANNING_HINTS, XRAY_STEP_IDS } from "./plan";
import { TOPIC_FOR_SECTION, XRAY_READER_TASK } from "./task";

export interface CompanyXrayPrompts {
  reader: PromptFile;
  researcher: PromptFile;
  synthesis: PromptFile;
}

export interface XrayRunPrompts extends CompanyXrayPrompts {
  planner: PromptFile;
  critic: PromptFile;
  editor: PromptFile;
  gapAnalysis?: PromptFile;
}

export interface CompanyXrayDependencies {
  ctx: RunContext;
  input: CompanyXrayInput;
  fetcher: Fetcher;
  prompts: XrayRunPrompts;
  run?: Omit<PlannedRunOptions, "plannerPrompt">;
}

export const XRAY_LIMITS = {
  crawlPages: 8,
  crawlBudgetPages: 60,
  crawlBudgetMs: 20_000,
  targetMs: 90_000,
  gapFillEndsAtMs: 60_000,
  synthesisMaxTokens: 7_000,
  synthesisFacts: 150,
  quotesPerSource: 12,
  deepRounds: 2,
} as const;

const SECTION_HINTS: Record<(typeof SECTION_KEYS)[number], readonly string[]> = {
  offering: ["products", "pricing", "platform", "features", "solutions"],
  customers: ["customers", "case", "stories", "clients", "partners"],
  market: ["about", "industry", "investors", "market", "company"],
  competitors: ["compare", "alternatives", "versus", "vs"],
  positioning: ["about", "why", "mission", "company"],
  news: ["news", "newsroom", "press", "blog", "announcements"],
  swot: ["investors", "annual", "report", "risks", "about"],
  techStack: ["careers", "jobs", "engineering", "developers", "docs", "integrations"],
};

function missingSections(facts: readonly TopicFact[]): string[] {
  const topics = new Set(facts.map((fact) => fact.topic));
  return Object.entries(TOPIC_FOR_SECTION)
    .filter(([, topic]) => !topics.has(topic))
    .map(([section]) => section);
}

function emptySections(note: string): CompanyXraySections {
  const insufficient = { status: "insufficient_evidence" as const, note };
  return {
    offering: insufficient,
    customers: insufficient,
    market: insufficient,
    competitors: insufficient,
    positioning: insufficient,
    news: insufficient,
    swot: insufficient,
    techStack: insufficient,
  };
}

interface BriefState {
  artifactId: string;
  version: number;
  companyName: string;
  oneLiner: Claim | null;
  sections: CompanyXraySections;
  facts: TopicFact[];
  final: boolean;
  specificity?: SpecificityReport;
  research?: ResearchReport;
  citationAccuracy?: number | null;
  publishedAccuracy?: number | null;
}

export function createCompanyXrayMission(deps: CompanyXrayDependencies): PlannedMission {
  const { ctx, input, prompts } = deps;
  const emit = ctx.emitter.emit.bind(ctx.emitter);
  const runId = ctx.runId;
  const clock = missionClock(ctx, XRAY_LIMITS.targetMs);
  const kit = createResearchKit({
    ctx,
    missionId: "company-xray",
    fetcher: deps.fetcher,
    siteUrl: input.url,
    ...(input.focus === undefined ? {} : { focus: input.focus }),
    readerTask: XRAY_READER_TASK,
    readerPrompt: prompts.reader,
    researcherPrompt: prompts.researcher,
    crawlPages: XRAY_LIMITS.crawlPages,
    crawl: {
      profile: COMPANY_PROFILE,
      maxPages: XRAY_LIMITS.crawlBudgetPages,
      maxDurationMs: XRAY_LIMITS.crawlBudgetMs,
    },
    clock,
    gapTopics: missingSections,
    gapFillDeadlineMs: XRAY_LIMITS.gapFillEndsAtMs,
    callsAfterGapFill: ["planner", "fast"],
  });
  let brief: BriefState | undefined;

  const promptVersions = [
    prompts.reader,
    prompts.researcher,
    prompts.synthesis,
    prompts.planner,
    prompts.critic,
    prompts.editor,
    ...(prompts.gapAnalysis === undefined ? [] : [prompts.gapAnalysis]),
  ].map((prompt) => `${prompt.name}@${prompt.version}`);

  const briefSources = (documents: readonly SourceDocument[], state: BriefState): BriefSource[] => {
    const cited = citedSourceIds(state.sections, state.oneLiner);
    return documents
      .filter((document) => cited.has(document.record.sourceId))
      .map((document) => ({
        ...document.record,
        quotes: state.facts
          .filter((fact) => fact.sourceId === document.record.sourceId)
          .map((fact) => fact.quote)
          .slice(0, XRAY_LIMITS.quotesPerSource),
      }));
  };
  const base = (state: BriefState) => {
    const documents = kit.documents();
    return {
      missionId: "company-xray" as const,
      company: { name: state.companyName, url: input.url, oneLiner: state.oneLiner },
      ...(input.focus === undefined ? {} : { focus: input.focus }),
      sources: briefSources(documents, state),
      sourceMix: sourceMix(documents),
      generatedAt: ctx.now().toISOString(),
      promptVersions,
      ...(state.specificity === undefined
        ? {}
        : {
            verification: {
              citationAccuracy: state.citationAccuracy ?? null,
              ...(state.publishedAccuracy === undefined
                ? {}
                : { publishedAccuracy: state.publishedAccuracy }),
              specificity: state.specificity,
              ...(state.research === undefined ? {} : { research: state.research }),
            },
          }),
    };
  };
  const publishFinal = async (state: BriefState, stepId: string | undefined) => {
    state.version += 1;
    const content = CompanyXrayBriefSchema.parse({
      ...base(state),
      status: "complete",
      sections: state.sections,
    });
    await emit({
      runId,
      type: "artifact.updated",
      ...(stepId === undefined ? {} : { stepId }),
      payload: { artifactId: state.artifactId, version: state.version, content },
    });
    state.final = true;
  };

  const specificityTarget = (state?: { companyName: string }): SpecificityTarget => {
    const stem = kit.env.scope.root.split(".")[0] ?? kit.env.scope.root;
    const named = kit.env.discoveries.names.filter((name) =>
      mentionsTarget(name, { names: [stem] }),
    );
    return {
      names: [...(state === undefined ? [] : [state.companyName]), ...named.slice(0, 2), stem],
    };
  };
  const specificityContext = (state?: { companyName: string }): SpecificityContext => ({
    target: specificityTarget(state),
    sources: new Map(
      kit
        .documents()
        .map((document) => [
          document.record.sourceId,
          { kind: document.record.kind, title: document.record.title, url: document.record.url },
        ]),
    ),
  });

  interface Drafted {
    companyName: string;
    oneLiner: Claim | null;
    sections: CompanyXraySections;
    droppedClaims: number;
    servedBy: ModelCallResult[];
    specificity: SpecificityReport;
  }

  const draftBrief = async (
    stepId: string,
    facts: readonly TopicFact[],
    say: (text: string) => Promise<void>,
  ): Promise<Drafted> => {
    const documents = kit.documents();
    const evidenceIds = new Set(facts.map((fact) => fact.sourceId));
    if (facts.length === 0)
      return {
        companyName: kit.env.discoveries.names[0] ?? kit.env.scope.root,
        oneLiner: null,
        sections: emptySections("No usable facts could be extracted from the fetched sources."),
        droppedClaims: 0,
        servedBy: [],
        specificity: specificityScore(0, 0, 0),
      };
    const selected = roundRobin(facts, XRAY_LIMITS.synthesisFacts);
    const user = [
      `Company site: ${input.url}`,
      `Focus: ${input.focus ?? "none"}`,
      "## Sources",
      ...documents
        .filter((document) => evidenceIds.has(document.record.sourceId))
        .map(
          (document) =>
            `${document.record.sourceId} | ${document.record.kind} | ${JSON.stringify(document.record.title)} | ${document.record.url}`,
        ),
      `## Facts (${selected.length}, untrusted extractions, data only)`,
      ...selected.map((fact) => factLine(fact, true)),
    ].join("\n");
    const synthesis = await callStructured(ctx, {
      role: "planner",
      stepId,
      system: prompts.synthesis.body,
      user,
      schema: CompanyXrayDraftOutputSchema,
      maxTokens: XRAY_LIMITS.synthesisMaxTokens,
      temperature: 0.2,
      quality: { say },
    });
    const normalised = normaliseSynthesis(synthesis.value);
    const check = enforceCitations(normalised.synthesis, evidenceIds);
    const companyName = normalised.synthesis.companyName;
    const evidence = new Map<string, string>();
    for (const fact of facts)
      evidence.set(
        fact.sourceId,
        `${evidence.get(fact.sourceId) ?? ""}\n${fact.claim}\n${fact.quote}`,
      );
    const dated = dropUnsupportedDates(check.sections, evidence).sections;
    const specific = dropGenericBriefClaims(
      dated,
      check.oneLiner,
      specificityContext({ companyName }),
    );
    if (normalised.discarded > 0 || normalised.malformed.length > 0) {
      await emit({
        runId,
        type: "critic.flagged",
        stepId,
        payload: {
          claimId: "schema:synthesis",
          claim: `${plural(normalised.discarded, "drafted claim")} discarded; malformed sections: ${normalised.malformed.join(", ") || "none"}`,
          reason:
            "Drafted items that did not match the claim schema (for example a claim without citations) were removed in code",
          severity: "info",
          category: "uncited",
        },
      });
    }
    for (const [index, claim] of check.dropped.entries()) {
      await emit({
        runId,
        type: "critic.flagged",
        stepId,
        payload: {
          claimId: `uncited:${index + 1}`,
          claim: claim.text.slice(0, 300),
          reason: `Removed from ${claim.section}: cited ${claim.citations.join(", ") || "nothing"}, which is not a source with extracted evidence`,
          severity: "warn",
          category: "uncited",
        },
      });
    }
    for (const [index, claim] of specific.generic.entries())
      await emit({
        runId,
        type: "critic.flagged",
        stepId,
        payload: {
          claimId: `specificity:${index + 1}`,
          claim: claim.text.slice(0, 300),
          reason: `Removed from ${claim.id.split(".")[0] ?? "the brief"}: general background, not a finding about ${companyName}`,
          severity: "info",
          category: "claim",
        },
      });
    return {
      companyName,
      oneLiner: specific.oneLiner,
      sections: specific.sections,
      droppedClaims: check.dropped.length + normalised.discarded + specific.generic.length,
      servedBy: synthesis.calls,
      specificity: specificityScore(specific.specific, specific.generic.length, 0),
    };
  };

  const publishDraft = async (state: BriefState, stepId: string) => {
    state.version += 1;
    await emit({
      runId,
      type: "artifact.updated",
      stepId,
      payload: {
        artifactId: state.artifactId,
        version: state.version,
        content: { ...base(state), status: "draft", sections: state.sections },
      },
    });
  };

  const synthesise: StepExecutor = {
    id: XRAY_STEP_IDS.synthesise,
    role: "editor",
    modelRole: "planner",
    capabilities: [CAPABILITIES.artifactWrite],
    required: true,
    needs: [XRAY_STEP_IDS.read],
    description:
      "Write the Company X-ray brief (offering, customers, market, competitors, positioning, news, SWOT, tech stack) from quarantined facts only; uncited claims and generic background that is not about the company are removed in code.",
    run: async (task): Promise<SubAgentResult> => {
      const stepId = task.step.id;
      const facts = findingsToFacts(inputFindings(task));
      const drafted = await draftBrief(stepId, facts, task.agent.say);
      const { companyName, oneLiner, sections, droppedClaims, servedBy } = drafted;
      const artifactId = crypto.randomUUID();
      const state: BriefState = {
        artifactId,
        version: 1,
        companyName,
        oneLiner,
        sections,
        facts,
        final: false,
        specificity: drafted.specificity,
      };
      brief = state;
      const title = `Company X-ray: ${companyName}`.slice(0, 200);
      const draft: CompanyXrayBriefDraft = { ...base(state), status: "draft", sections: {} };
      await emit({
        runId,
        type: "artifact.created",
        stepId,
        payload: { artifactId, kind: "company-xray-brief", title, version: 1, content: draft },
      });
      const progressive: Partial<CompanyXraySections> = {};
      for (const key of SECTION_KEYS) {
        Object.assign(progressive, { [key]: sections[key] });
        state.version += 1;
        await emit({
          runId,
          type: "artifact.updated",
          stepId,
          payload: {
            artifactId,
            version: state.version,
            content: { ...base(state), status: "draft", sections: { ...progressive } },
          },
        });
      }
      const supported = SECTION_KEYS.filter((key) => sections[key].status === "ok");
      await task.agent.say(
        `Drafted ${supported.length} of ${SECTION_KEYS.length} sections (${supported.map((key) => SECTION_TITLES[key]).join(", ") || "none"})${droppedClaims === 0 ? "" : `; removed ${plural(droppedClaims, "uncited or generic claim")}`}. The critic checks every claim next.`,
      );
      const cited = citedSourceIds(sections, oneLiner);
      return {
        summary: withQualityNote(
          `${supported.length} of ${SECTION_KEYS.length} sections drafted from evidence`,
          servedBy,
        ),
        findings: facts.filter((fact) => cited.has(fact.sourceId)).map(factToFinding),
        sources: base(state).sources.map(({ quotes: _quotes, ...record }) => record),
        confidence: supported.length / SECTION_KEYS.length,
        artifacts: [artifactId],
      };
    },
  };

  const sectionDrafts = (state: BriefState): SectionDraft[] =>
    SECTION_KEYS.map((key) => ({
      key,
      title: SECTION_TITLES[key],
      claims: listBriefClaims({ ...emptySections(""), [key]: state.sections[key] }, null).length,
      keywords: SECTION_HINTS[key],
    }));

  const deepen: StepExecutor = {
    id: XRAY_STEP_IDS.deepen,
    role: "researcher",
    modelRole: "planner",
    capabilities: [CAPABILITIES.webFetch, CAPABILITIES.artifactWrite],
    needs: [XRAY_STEP_IDS.synthesise],
    description:
      "Deep research after the first draft: a planner-role gap analysis picks follow-up leads (unread pages from the crawl frontier, the feed, GitHub, Wikipedia/Wikidata) for thin sections; new pages are read in quarantine and the brief is redrafted, while the time target allows.",
    run: async (task): Promise<SubAgentResult> => {
      const state = brief;
      if (state === undefined || !inputArtifacts(task).includes(state.artifactId))
        return {
          summary: "No drafted brief to deepen.",
          findings: [],
          sources: [],
          confidence: 0.5,
          artifacts: [],
        };
      const outcome = await runDeepResearch({
        ctx,
        stepId: task.step.id,
        agent: task.agent,
        prompt: prompts.gapAnalysis,
        objective: `Company X-ray of ${state.companyName} (${input.url})${input.focus === undefined ? "" : `, focus: ${input.focus}`}`,
        maxRounds: XRAY_LIMITS.deepRounds,
        canContinue: () => clock.fits(["planner", "fast", "planner", "fast", "worker"]),
        canRedraft: () => clock.fits(["planner", "fast", "worker"]),
        usePlanner: () => clock.fits(["planner", "planner", "fast", "worker"]),
        sections: () => sectionDrafts(state),
        candidates: () => kit.followUps(task),
        redraft: async (fresh) => {
          const facts = [...state.facts, ...fresh];
          const drafted = await draftBrief(task.step.id, facts, task.agent.say);
          const before = SECTION_KEYS.filter((key) => state.sections[key].status === "ok").length;
          const after = SECTION_KEYS.filter((key) => drafted.sections[key].status === "ok").length;
          if (after < before) return;
          state.facts = facts;
          state.companyName = drafted.companyName;
          state.oneLiner = drafted.oneLiner;
          state.sections = drafted.sections;
          state.specificity = drafted.specificity;
          await publishDraft(state, task.step.id);
        },
      });
      state.research = outcome.report;
      const cited = citedSourceIds(state.sections, state.oneLiner);
      return {
        summary: `Deep research: ${plural(outcome.report.rounds.length, "round")}, ${plural(outcome.facts.length, "new fact")}, coverage ${Math.round(outcome.report.coverage * 100)}% (stop: ${outcome.report.stopReason.replace(/_/g, " ")})`,
        findings: state.facts.filter((fact) => cited.has(fact.sourceId)).map(factToFinding),
        sources: base(state).sources.map(({ quotes: _quotes, ...record }) => record),
        confidence: outcome.report.coverage,
        artifacts: [state.artifactId],
        research: outcome.report,
      };
    },
  };

  const critic: StepExecutor = {
    id: XRAY_STEP_IDS.critic,
    role: "critic",
    modelRole: "fast",
    capabilities: [CAPABILITIES.artifactWrite],
    required: true,
    needs: [XRAY_STEP_IDS.synthesise],
    description:
      "Extract atomic claims from the brief, check each against its cited quotes (entailment) and whether it is about the company, send unsupported claims to an editor sub-agent with the exact supporting span (at most two loops), split compound claims, remove what stays unsupported and report citation accuracy and specificity.",
    run: async (task): Promise<SubAgentResult> => {
      const state = brief;
      if (state === undefined || !inputArtifacts(task).includes(state.artifactId))
        throw new Error("The critic has no drafted brief to check");
      const facts = findingsToFacts(inputFindings(task));
      const known = new Set(facts.map((fact) => `${fact.sourceId}|${fact.quote}`));
      const evidenceFacts = [
        ...facts,
        ...state.facts.filter((fact) => !known.has(`${fact.sourceId}|${fact.quote}`)),
      ];
      const target = specificityTarget(state);
      const outcome = await runCriticSafely(ctx, listBriefClaims(state.sections, state.oneLiner), {
        stepId: task.step.id,
        agent: task.agent,
        spawnEditor: () => task.spawn("editor", "worker"),
        prompts: { critic: prompts.critic, editor: prompts.editor },
        deliverable: `Company X-ray brief for ${state.companyName}`,
        evidence: quotesBySource(evidenceFacts),
        canFix: () => clock.fits(["worker", "fast"]),
        specificity: {
          target: state.companyName,
          mentionsTarget: (text) => mentionsTarget(text, target),
        },
      });
      const applied = applyBriefClaims(state.sections, state.oneLiner, outcome.kept);
      state.sections = applied.sections;
      state.oneLiner = applied.oneLiner;
      const drafted = state.specificity ?? specificityScore(0, 0, 0);
      const specificity = specificityScore(
        Math.max(0, drafted.specific - outcome.generic.length),
        drafted.generic + outcome.generic.length,
        0,
      );
      state.specificity = specificity;
      state.citationAccuracy = outcome.report.citationAccuracy;
      state.publishedAccuracy = outcome.report.publishedAccuracy ?? null;
      const report = { ...outcome.report, specificity };
      await publishFinal(state, task.step.id);
      const accuracy = formatAccuracy(report);
      await task.agent.say(
        `Checked ${plural(outcome.report.claimsChecked, "claim")}: ${accuracy}.`,
      );
      return {
        summary: `Brief verified: ${accuracy}`,
        findings: [],
        sources: [],
        confidence: outcome.report.citationAccuracy ?? 0.5,
        artifacts: [state.artifactId],
        critic: report,
      };
    },
  };

  return {
    planner: {
      missionId: "company-xray",
      title: "Company X-ray",
      objective:
        "A cited brief on the company: offering, customers, market, competitors, positioning, recent news, SWOT and tech-stack signals. Every claim cites a fetched source.",
      input,
      planningHints: XRAY_PLANNING_HINTS,
      executors: [...kit.executors, synthesise, deepen, critic],
      allowedCapabilities: [CAPABILITIES.webFetch, CAPABILITIES.artifactWrite],
    },
    defaultPlan: XRAY_PLAN,
    clock,
    finish: async (outcome) => {
      const state = brief;
      if (state === undefined)
        return { status: "failed", error: stepFailure(outcome, XRAY_STEP_IDS.synthesise) };
      if (!state.final) {
        await emit({
          runId,
          type: "critic.flagged",
          payload: {
            claimId: "critic:skipped",
            claim: "The brief's claims were not checked against their quotes",
            reason:
              "The critic step did not complete, so the brief is published with code-enforced citations only",
            severity: "info",
            category: "claim",
          },
        });
        const unverified = applyBriefClaims(
          state.sections,
          state.oneLiner,
          unverifiedOutcome(listBriefClaims(state.sections, state.oneLiner)).kept,
        );
        state.sections = unverified.sections;
        state.oneLiner = unverified.oneLiner;
        await publishFinal(state, undefined);
      }
      const actions: NextActions = {
        missionId: "company-xray",
        actions: [
          {
            id: "run-automation-audit",
            label: "Run AI Automation Audit",
            description:
              "Find 5–8 workflows at this company that agents could automate, with an explicit ROI model.",
            missionId: "automation-audit",
            input: { url: input.url, ...(input.focus === undefined ? {} : { focus: input.focus }) },
            available: true,
          },
        ],
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
      const supported = SECTION_KEYS.filter((key) => state.sections[key].status === "ok");
      const report = outcome.results.get(XRAY_STEP_IDS.critic)?.critic;
      const cited = base(state).sources.length;
      return {
        status: "completed",
        summary: `Company X-ray for ${state.companyName}: ${supported.length} of ${SECTION_KEYS.length} sections supported by ${plural(cited, "cited source")} (${describeMix(kit.documents())} fetched)${report === undefined ? "" : `; ${formatAccuracy(report)}`}.`,
      };
    },
  };
}

export async function runCompanyXray(
  deps: CompanyXrayDependencies,
): Promise<"completed" | "failed"> {
  return runPlannedMission(deps.ctx, createCompanyXrayMission(deps), {
    plannerPrompt: deps.prompts.planner,
    ...deps.run,
  });
}
