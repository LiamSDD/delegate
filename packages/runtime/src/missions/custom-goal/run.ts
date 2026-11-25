import { CAPABILITIES } from "@delegate/policy";

import { type RunContext } from "../../agent/context";
import { formatAccuracy, runCriticSafely, unverifiedOutcome } from "../../agent/critic";
import {
  runPlannedMission,
  stepFailure,
  type PlannedMission,
  type PlannedRunOptions,
} from "../../agent/mission-runner";
import { withQualityNote, type ModelCallResult } from "../../agent/model-call";
import { chainHead, missionClock } from "../../agent/pacing";
import {
  FatalStepError,
  inputArtifacts,
  inputFindings,
  type StepExecutor,
  type SubAgentResult,
  type SubAgentTask,
} from "../../agent/subagent";
import { callStructured } from "../../agent/structured";
import { type PromptFile } from "../../prompts";
import { READER_DEFAULTS, readUntrusted } from "../../quarantine/reader";
import { NoModelAvailableError } from "../../router";
import { type Fetcher } from "../../tools/fetch";
import { executeToolCall, type ToolCaller, type ToolCallOutcome } from "../../tools/registry";
import { SourceStore, type SourceDocument } from "../../tools/sources";
import { NEXT_ACTIONS_KIND, type NextAction, type NextActions } from "../next-actions";
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
  type ResearchKit,
  type TopicFact,
} from "../shared/research";
import { type CustomGoalInput } from "./input";
import { GOAL_PLANNING_HINTS, GOAL_STEP_IDS, GOAL_STEP_LIMITS, defaultGoalPlan } from "./plan";
import {
  FOLLOW_UP_MISSIONS,
  GOAL_BRIEF_KIND,
  GoalBriefSchema,
  GoalSynthesisOutputSchema,
  RANK_FORMULA,
  applyGoalClaims,
  goalCitedSources,
  listGoalClaims,
  normaliseGoalSynthesis,
  type FollowUpMission,
  type GoalBriefDraft,
  type GoalCompany,
  type GoalSections,
} from "./schema";
import { analyseGoal } from "./target";
import { goalReaderTask } from "./task";
import { createCompanyResolver, createReferenceSearch } from "./tools";

export interface CustomGoalPrompts {
  reader: PromptFile;
  researcher: PromptFile;
  goalSynthesis: PromptFile;
  planner: PromptFile;
  critic: PromptFile;
  editor: PromptFile;
}

export interface CustomGoalDependencies {
  ctx: RunContext;
  input: CustomGoalInput;
  fetcher: Fetcher;
  prompts: CustomGoalPrompts;
  run?: Omit<PlannedRunOptions, "plannerPrompt">;
}

export const GOAL_LIMITS = {
  crawlPages: 6,
  targetMs: 120_000,
  synthesisMaxTokens: 6_000,
  synthesisFacts: 120,
  quotesPerSource: 12,
} as const;

const MISSION_ID = "custom-goal";

const FOLLOW_UP_LABELS: Record<FollowUpMission, string> = {
  "company-xray": "Run Company X-ray",
  "automation-audit": "Run AI Automation Audit",
  "build-agent": "Build it",
  "repo-xray": "Run Repo X-ray",
  "ship-a-pr": "Ship a PR",
};
const URL_MISSIONS: ReadonlySet<FollowUpMission> = new Set(["company-xray", "automation-audit"]);

interface BriefState {
  artifactId: string;
  version: number;
  objective: string;
  sections: GoalSections;
  facts: TopicFact[];
  final: boolean;
}

function skipped(summary: string, confidence = 0.6): SubAgentResult {
  return { summary, findings: [], sources: [], confidence, artifacts: [] };
}

function artifactsOf(outcomes: readonly ToolCallOutcome[]): string[] {
  return outcomes.flatMap((outcome) =>
    outcome.artifactId === undefined ? [] : [outcome.artifactId],
  );
}

function hostLabel(host: string): string {
  return host.replace(/^www\./, "");
}

export function goalNextActions(sections: GoalSections, company: GoalCompany | null): NextAction[] {
  const actions: NextAction[] = [];
  const seen = new Set<string>();
  for (const action of sections.actions) {
    const mission = action.mission;
    if (mission === null) continue;
    if (mission === "build-agent") {
      if (company === null || seen.has(`build:${action.title}`)) continue;
      seen.add(`build:${action.title}`);
      actions.push({
        id: `build-${action.rank}`,
        label: `Build it: ${action.title}`.slice(0, 120),
        description: action.basis.text.slice(0, 300),
        missionId: "build-agent",
        input: { url: company.url, goal: action.title, name: action.title.slice(0, 80) },
        available: true,
      });
      continue;
    }
    if (seen.has(mission)) continue;
    seen.add(mission);
    const needsUrl = URL_MISSIONS.has(mission);
    actions.push({
      id: `run-${mission}`,
      label: FOLLOW_UP_LABELS[mission],
      description: `From action ${action.rank}: ${action.title}`.slice(0, 300),
      missionId: mission,
      input: needsUrl && company !== null ? { url: company.url } : {},
      available: needsUrl && company !== null,
    });
  }
  if (company !== null)
    for (const mission of ["automation-audit", "company-xray"] as const)
      if (!seen.has(mission))
        actions.push({
          id: `run-${mission}`,
          label: FOLLOW_UP_LABELS[mission],
          description: `Go deeper on ${company.name}.`,
          missionId: mission,
          input: { url: company.url },
          available: true,
        });
  return actions.slice(0, 8);
}

export function createCustomGoalMission(deps: CustomGoalDependencies): PlannedMission {
  const { ctx, input, prompts } = deps;
  const emit = ctx.emitter.emit.bind(ctx.emitter);
  const runId = ctx.runId;
  const clock = missionClock(ctx, GOAL_LIMITS.targetMs);
  const target = analyseGoal(input.goal, input.url);
  const store = new SourceStore();
  const readerTask = goalReaderTask(input.goal);
  const resolver = createCompanyResolver(deps.fetcher, ctx.signal);
  const reference = createReferenceSearch(deps.fetcher, store, ctx.signal);
  let company: GoalCompany | null = null;
  let kit: ResearchKit | undefined;
  let brief: BriefState | undefined;

  const promptVersions = [
    prompts.reader,
    prompts.goalSynthesis,
    prompts.planner,
    prompts.critic,
    prompts.editor,
  ].map((prompt) => `${prompt.name}@${prompt.version}`);

  const caller = (): ToolCaller => {
    const entry = chainHead(ctx, "fast");
    return {
      actor: { type: "system", id: MISSION_ID },
      ...(entry === undefined
        ? {}
        : { provider: { id: entry.provider.id, terms: entry.provider.terms } }),
    };
  };
  const runTool = (task: SubAgentTask, tool: typeof resolver.tool, args: unknown) =>
    executeToolCall(
      ctx,
      task.grant,
      [tool],
      { name: tool.name, argumentsJson: JSON.stringify(args) },
      caller(),
    );

  const read = (stepId: string, documents: readonly SourceDocument[]) => {
    const entry = chainHead(ctx, "fast");
    if (entry === undefined) throw new NoModelAvailableError("fast", []);
    return readUntrusted(ctx, {
      stepId,
      task: readerTask,
      systemPrompt: prompts.reader.body,
      concurrency: entry.provider.limits?.maxConcurrent ?? READER_DEFAULTS.concurrency,
      batchChars: 1,
      factBudgetPerCall: readerTask.maxFactsPerSource,
      sources: documents.map((document) => ({
        sourceId: document.record.sourceId,
        text: document.text,
        hiddenText: document.hiddenText,
        label: `${document.record.kind}: ${document.record.title}`,
      })),
    });
  };

  const kitFor = (url: string): ResearchKit => {
    kit ??= createResearchKit({
      ctx,
      missionId: MISSION_ID,
      fetcher: deps.fetcher,
      siteUrl: url,
      readerTask,
      readerPrompt: prompts.reader,
      researcherPrompt: prompts.researcher,
      crawlPages: GOAL_LIMITS.crawlPages,
      clock,
      gapTopics: () => [],
      gapFillDeadlineMs: 0,
      callsAfterGapFill: [],
      sources: store,
    });
    return kit;
  };
  const delegate = async (task: SubAgentTask, stepId: string): Promise<SubAgentResult> => {
    if (company === null)
      return skipped("Skipped: the goal names no company that could be resolved.", 0.5);
    const executor = kitFor(company.url).executors.find((candidate) => candidate.id === stepId);
    if (executor === undefined) throw new Error(`No research executor ${stepId}`);
    try {
      return await executor.run(task);
    } catch (error) {
      if (!(error instanceof FatalStepError)) throw error;
      await task.agent.say(`Could not read ${company.url}; the brief relies on other sources.`);
      return skipped(`Company site unreadable: ${error.message}`.slice(0, 900), 0.2);
    }
  };

  const resolve: StepExecutor = {
    id: GOAL_STEP_IDS.resolve,
    role: "researcher",
    modelRole: "fast",
    capabilities: [CAPABILITIES.webFetch],
    required: true,
    description:
      "Resolve the company or domain named in the goal: a typed domain wins; otherwise brand names are looked up on Wikidata and accepted only if the entity's label matches and it lists an official website. No model calls.",
    run: async (task) => {
      if (target.domain !== null) {
        company = {
          name: hostLabel(target.domain.host),
          url: target.domain.url,
          resolvedBy: input.url === undefined ? "domain" : "input",
        };
        await task.agent.say(
          `Target: ${company.url} (${company.resolvedBy === "input" ? "given" : "named in the goal"}).`,
        );
        return skipped(`Company site ${company.url}`, 1);
      }
      if (target.brands.length === 0) {
        await task.agent.say(
          "The goal names no company or domain; research covers the topic only.",
        );
        return skipped("No company or domain named in the goal", 0.8);
      }
      const outcome = await runTool(task, resolver.tool, { names: target.brands });
      company = resolver.resolved();
      const summary =
        company === null
          ? `No official site found for ${target.brands.join(", ")}`
          : `Resolved ${company.name} to ${company.url} via Wikidata ${company.entity ?? ""}`.trim();
      await task.agent.say(
        company === null
          ? `Looked up ${target.brands.join(", ")} on Wikidata: no entity with a matching name lists an official website, so no company is assumed.`
          : `Looked up ${target.brands.join(", ")} on Wikidata: ${company.name} lists ${company.url} as its official website.`,
      );
      return {
        summary,
        findings: [],
        sources: [],
        confidence: company === null ? 0.5 : 0.9,
        artifacts: artifactsOf([outcome]),
      };
    },
  };

  const site: StepExecutor = {
    id: GOAL_STEP_IDS.site,
    role: "researcher",
    modelRole: "fast",
    capabilities: [CAPABILITIES.webFetch],
    needs: [GOAL_STEP_IDS.resolve],
    description:
      "Crawl the resolved company's own site (robots.txt, sitemap, same-site scope, page cap). Skips itself when no company was resolved. No model calls.",
    run: (task) => delegate(task, GOAL_STEP_IDS.site),
  };
  const external: StepExecutor = {
    id: GOAL_STEP_IDS.external,
    role: "researcher",
    modelRole: "fast",
    capabilities: [CAPABILITIES.webFetch],
    needs: [GOAL_STEP_IDS.site],
    description:
      "Look the resolved company up on Wikipedia/Wikidata, its GitHub organisation and its feed, then read those sources through the quarantined reader.",
    run: (task) => delegate(task, GOAL_STEP_IDS.external),
  };
  const readSite: StepExecutor = {
    id: GOAL_STEP_IDS.read,
    role: "analyst",
    modelRole: "fast",
    capabilities: [],
    needs: [GOAL_STEP_IDS.site],
    description:
      "Read every company page through the quarantined reader (tool-less, schema-validated), keeping goal-relevant facts whose quote appears verbatim.",
    run: (task) => delegate(task, GOAL_STEP_IDS.read),
  };

  const topic: StepExecutor = {
    id: GOAL_STEP_IDS.topic,
    role: "researcher",
    modelRole: "fast",
    capabilities: [CAPABILITIES.webFetch],
    required: true,
    description:
      "Search English Wikipedia for the goal's topics (keyless) and read the best matches through the quarantined reader.",
    run: async (task) => {
      if (target.queries.length === 0)
        return skipped("The goal has no searchable topic words.", 0.4);
      const outcome = await runTool(task, reference.tool, { queries: target.queries });
      const documents = reference.created();
      if (documents.length === 0) {
        await task.agent.say(`No reference articles matched ${target.queries.join("; ")}.`);
        return { ...skipped("No reference sources found", 0.4), artifacts: artifactsOf([outcome]) };
      }
      const readings = await read(task.step.id, documents);
      const facts = readings.flatMap((reading) => reading.facts);
      const suspected = readings.filter((reading) => reading.injectionSuspected).length;
      const dropped = readings.reduce((sum, reading) => sum + reading.droppedFacts, 0);
      const unread = readings.filter((reading) => reading.error !== undefined).length;
      await task.agent.say(
        `Read ${plural(documents.length, "reference article")} for "${target.queries.join("; ")}" in quarantine: kept ${plural(facts.length, "fact")} with verbatim quotes, dropped ${dropped} whose quote did not match${suspected === 0 ? "" : `; ${plural(suspected, "source")} flagged for suspected prompt injection`}${unread === 0 ? "" : `; ${plural(unread, "source")} could not be read`}.`,
      );
      return {
        summary: `${plural(documents.length, "reference source")}, ${plural(facts.length, "fact")}`,
        findings: facts.map(factToFinding),
        sources: documents.map((document) => document.record),
        confidence: facts.length > 0 ? 0.8 : 0.4,
        artifacts: artifactsOf([outcome]),
      };
    },
  };

  const base = (state: BriefState) => {
    const documents = store.all();
    const cited = goalCitedSources(state.sections);
    return {
      missionId: "custom-goal" as const,
      goal: input.goal,
      objective: state.objective,
      company,
      sources: documents
        .filter((document) => cited.has(document.record.sourceId))
        .map((document) => ({
          ...document.record,
          quotes: state.facts
            .filter((fact) => fact.sourceId === document.record.sourceId)
            .map((fact) => fact.quote)
            .slice(0, GOAL_LIMITS.quotesPerSource),
        })),
      sourceMix: sourceMix(documents),
      rankFormula: RANK_FORMULA,
      generatedAt: ctx.now().toISOString(),
      promptVersions,
    };
  };
  const publishFinal = async (state: BriefState, stepId: string | undefined) => {
    state.version += 1;
    const content = GoalBriefSchema.parse({
      ...base(state),
      status: "complete",
      ...state.sections,
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
    id: GOAL_STEP_IDS.synthesise,
    role: "editor",
    modelRole: "planner",
    capabilities: [CAPABILITIES.artifactWrite],
    required: true,
    needs: [GOAL_STEP_IDS.resolve, GOAL_STEP_IDS.topic],
    description:
      "Write the goal brief (objective, findings by workstream, ranked action plan with owner, effort, impact and follow-up mission, risks, open questions) from quarantined facts only; uncited claims are removed in code.",
    run: async (task): Promise<SubAgentResult> => {
      const stepId = task.step.id;
      const facts = findingsToFacts(inputFindings(task));
      const evidenceIds = new Set(facts.map((fact) => fact.sourceId));
      let objective = input.goal.slice(0, 400);
      let sections: GoalSections = { workstreams: [], actions: [], risks: [], openQuestions: [] };
      let servedBy: ModelCallResult[] = [];
      if (facts.length > 0) {
        const selected = roundRobin(facts, GOAL_LIMITS.synthesisFacts);
        const user = [
          `## Goal (from the user)\n${JSON.stringify(input.goal)}`,
          `## Company\n${company === null ? "none resolved" : `${company.name} — ${company.url}`}`,
          `## Follow-up missions\n${FOLLOW_UP_MISSIONS.join(", ")}`,
          "## Sources",
          ...store
            .all()
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
          system: prompts.goalSynthesis.body,
          user,
          schema: GoalSynthesisOutputSchema,
          maxTokens: GOAL_LIMITS.synthesisMaxTokens,
          temperature: 0.2,
          quality: { say: task.agent.say },
        });
        servedBy = synthesis.calls;
        const normalised = normaliseGoalSynthesis(synthesis.value, evidenceIds);
        objective = normalised.objective;
        sections = normalised.sections;
        if (normalised.discarded > 0)
          await emit({
            runId,
            type: "critic.flagged",
            stepId,
            payload: {
              claimId: "schema:synthesis",
              claim: `${plural(normalised.discarded, "drafted item")} discarded`,
              reason:
                "Drafted items that did not match the brief schema (for example a claim without citations) were removed in code",
              severity: "info",
              category: "uncited",
            },
          });
        for (const [index, dropped] of normalised.dropped.entries())
          await emit({
            runId,
            type: "critic.flagged",
            stepId,
            payload: {
              claimId: `uncited:${index + 1}`,
              claim: dropped.claim.text.slice(0, 300),
              reason: `Removed from ${dropped.where.slice(0, 120)}: cited ${dropped.claim.citations.join(", ")}, which is not a source with extracted evidence`,
              severity: "warn",
              category: "uncited",
            },
          });
      }
      const artifactId = crypto.randomUUID();
      const state: BriefState = {
        artifactId,
        version: 1,
        objective,
        sections,
        facts,
        final: false,
      };
      brief = state;
      const draft: GoalBriefDraft = { ...base(state), status: "draft", ...sections };
      await emit({
        runId,
        type: "artifact.created",
        stepId,
        payload: {
          artifactId,
          kind: GOAL_BRIEF_KIND,
          title: `Goal brief: ${objective}`.slice(0, 200),
          version: 1,
          content: draft,
        },
      });
      await task.agent.say(
        facts.length === 0
          ? "No usable facts were extracted, so the brief has no findings or actions; it says so instead of guessing."
          : `Drafted ${plural(sections.workstreams.length, "workstream")}, ${plural(sections.actions.length, "ranked action")} and ${plural(sections.risks.length, "risk")}. The critic checks every cited claim next.`,
      );
      const cited = goalCitedSources(sections);
      return {
        summary: withQualityNote(
          `${plural(sections.workstreams.length, "workstream")} and ${plural(sections.actions.length, "action")} drafted from evidence`,
          servedBy,
        ),
        findings: facts.filter((fact) => cited.has(fact.sourceId)).map(factToFinding),
        sources: [],
        confidence: sections.actions.length > 0 ? 0.8 : 0.3,
        artifacts: [artifactId],
      };
    },
  };

  const critic: StepExecutor = {
    id: GOAL_STEP_IDS.critic,
    role: "critic",
    modelRole: "fast",
    capabilities: [CAPABILITIES.artifactWrite],
    required: true,
    needs: [GOAL_STEP_IDS.synthesise],
    description:
      "Check every finding, action basis and risk against its cited quotes (entailment), send unsupported claims to an editor sub-agent, remove what stays unsupported and report citation accuracy.",
    run: async (task): Promise<SubAgentResult> => {
      const state = brief;
      if (state === undefined || !inputArtifacts(task).includes(state.artifactId))
        throw new Error("The critic has no drafted brief to check");
      const outcome = await runCriticSafely(ctx, listGoalClaims(state.sections), {
        stepId: task.step.id,
        agent: task.agent,
        spawnEditor: () => task.spawn("editor", "worker"),
        prompts: { critic: prompts.critic, editor: prompts.editor },
        deliverable: `Goal brief for: ${state.objective}`,
        evidence: quotesBySource(state.facts),
        canFix: () => clock.fits(["worker", "fast"]),
      });
      state.sections = applyGoalClaims(state.sections, outcome.kept);
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
      missionId: MISSION_ID,
      title: "Custom goal",
      objective:
        "A cited goal brief: the objective restated, findings by workstream, a ranked action plan (owner role, effort, impact, follow-up Delegate mission), risks and open questions. Every factual claim cites a fetched source.",
      input: {
        goal: input.goal,
        ...(target.domain === null ? {} : { domain: target.domain.url }),
        brandCandidates: target.brands,
        topicQueries: target.queries,
      },
      planningHints: GOAL_PLANNING_HINTS,
      executors: [resolve, site, topic, external, readSite, synthesise, critic],
      allowedCapabilities: [CAPABILITIES.webFetch, CAPABILITIES.artifactWrite],
      stepLimits: GOAL_STEP_LIMITS,
    },
    defaultPlan: defaultGoalPlan(target.domain !== null || target.brands.length > 0),
    clock,
    finish: async (outcome) => {
      const state = brief;
      if (state === undefined)
        return { status: "failed", error: stepFailure(outcome, GOAL_STEP_IDS.synthesise) };
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
        state.sections = applyGoalClaims(
          state.sections,
          unverifiedOutcome(listGoalClaims(state.sections)).kept,
        );
        await publishFinal(state, undefined);
      }
      const actions: NextActions = {
        missionId: MISSION_ID,
        actions: goalNextActions(state.sections, company),
      };
      if (actions.actions.length > 0)
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
      const report = outcome.results.get(GOAL_STEP_IDS.critic)?.critic;
      const cited = base(state).sources.length;
      return {
        status: "completed",
        summary: `Goal brief${company === null ? "" : ` for ${company.name}`}: ${plural(state.sections.workstreams.length, "workstream")}, ${plural(state.sections.actions.length, "ranked action")}, ${plural(cited, "cited source")} (${describeMix(store.all())} fetched)${report === undefined ? "" : `; ${formatAccuracy(report)}`}.`,
      };
    },
  };
}

export async function runCustomGoal(deps: CustomGoalDependencies): Promise<"completed" | "failed"> {
  return runPlannedMission(deps.ctx, createCustomGoalMission(deps), {
    plannerPrompt: deps.prompts.planner,
    ...deps.run,
  });
}
