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
import { applyBriefClaims, listBriefClaims } from "./claims";
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
} as const;

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

  const synthesise: StepExecutor = {
    id: XRAY_STEP_IDS.synthesise,
    role: "editor",
    modelRole: "planner",
    capabilities: [CAPABILITIES.artifactWrite],
    required: true,
    needs: [XRAY_STEP_IDS.read],
    description:
      "Write the Company X-ray brief (offering, customers, market, competitors, positioning, news, SWOT, tech stack) from quarantined facts only; uncited claims are removed in code.",
    run: async (task): Promise<SubAgentResult> => {
      const stepId = task.step.id;
      const facts = findingsToFacts(inputFindings(task));
      const documents = kit.documents();
      const evidenceIds = new Set(facts.map((fact) => fact.sourceId));
      let companyName = kit.env.discoveries.names[0] ?? kit.env.scope.root;
      let oneLiner: Claim | null = null;
      let sections: CompanyXraySections;
      let droppedClaims = 0;
      let servedBy: ModelCallResult[] = [];
      if (facts.length === 0) {
        sections = emptySections("No usable facts could be extracted from the fetched sources.");
      } else {
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
          quality: { say: task.agent.say },
        });
        servedBy = synthesis.calls;
        const normalised = normaliseSynthesis(synthesis.value);
        const check = enforceCitations(normalised.synthesis, evidenceIds);
        companyName = normalised.synthesis.companyName;
        oneLiner = check.oneLiner;
        const evidence = new Map<string, string>();
        for (const fact of facts)
          evidence.set(
            fact.sourceId,
            `${evidence.get(fact.sourceId) ?? ""}\n${fact.claim}\n${fact.quote}`,
          );
        sections = dropUnsupportedDates(check.sections, evidence).sections;
        droppedClaims = check.dropped.length + normalised.discarded;
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
      }
      const artifactId = crypto.randomUUID();
      const state: BriefState = {
        artifactId,
        version: 1,
        companyName,
        oneLiner,
        sections,
        facts,
        final: false,
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
        `Drafted ${supported.length} of ${SECTION_KEYS.length} sections (${supported.map((key) => SECTION_TITLES[key]).join(", ") || "none"})${droppedClaims === 0 ? "" : `; removed ${plural(droppedClaims, "uncited claim")}`}. The critic checks every claim next.`,
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

  const critic: StepExecutor = {
    id: XRAY_STEP_IDS.critic,
    role: "critic",
    modelRole: "fast",
    capabilities: [CAPABILITIES.artifactWrite],
    required: true,
    needs: [XRAY_STEP_IDS.synthesise],
    description:
      "Extract atomic claims from the brief, check each against its cited quotes (entailment), send unsupported claims to an editor sub-agent (at most two loops), remove what stays unsupported and report citation accuracy.",
    run: async (task): Promise<SubAgentResult> => {
      const state = brief;
      if (state === undefined || !inputArtifacts(task).includes(state.artifactId))
        throw new Error("The critic has no drafted brief to check");
      const facts = findingsToFacts(inputFindings(task));
      const outcome = await runCriticSafely(ctx, listBriefClaims(state.sections, state.oneLiner), {
        stepId: task.step.id,
        agent: task.agent,
        spawnEditor: () => task.spawn("editor", "worker"),
        prompts: { critic: prompts.critic, editor: prompts.editor },
        deliverable: `Company X-ray brief for ${state.companyName}`,
        evidence: quotesBySource(facts.length > 0 ? facts : state.facts),
        canFix: () => clock.fits(["worker", "fast"]),
      });
      const applied = applyBriefClaims(state.sections, state.oneLiner, outcome.kept);
      state.sections = applied.sections;
      state.oneLiner = applied.oneLiner;
      await publishFinal(state, task.step.id);
      const accuracy = formatAccuracy(outcome.report);
      await task.agent.say(
        `Checked ${plural(outcome.report.claimsChecked, "claim")}: ${accuracy}.`,
      );
      return {
        summary: `Brief verified: ${accuracy}`,
        findings: [],
        sources: [],
        confidence: outcome.report.citationAccuracy ?? 0.5,
        artifacts: [state.artifactId],
        critic: outcome.report,
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
      executors: [...kit.executors, synthesise, critic],
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
