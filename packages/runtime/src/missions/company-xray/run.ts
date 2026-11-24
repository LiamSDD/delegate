import { BudgetExceededError } from "../../budget";
import { type AgentRole, type ModelRole } from "../../events";
import { resolveChain } from "../../models";
import { type PromptFile } from "../../prompts";
import { NoModelAvailableError } from "../../router";
import { RunAbortedError, type RunContext } from "../../agent/context";
import { runAgentLoop } from "../../agent/loop";
import { StructuredOutputError, callStructured } from "../../agent/structured";
import { READER_DEFAULTS, readUntrusted, type UntrustedFact } from "../../quarantine/reader";
import { type Fetcher } from "../../tools/fetch";
import {
  executeToolCall,
  type StepGrant,
  type ToolCaller,
  type ToolCallOutcome,
} from "../../tools/registry";
import {
  createResearchEnvironment,
  createResearchTools,
  type ResearchEnvironment,
} from "../../tools/research";
import { SOURCE_KINDS, type SourceDocument } from "../../tools/sources";
import {
  CompanyXrayBriefSchema,
  CompanyXrayDraftOutputSchema,
  SECTION_KEYS,
  SECTION_TITLES,
  citedSourceIds,
  enforceCitations,
  normaliseSynthesis,
  dropUnsupportedDates,
  type BriefSource,
  type CompanyXrayBriefDraft,
  type CompanyXraySections,
} from "./brief";
import { type CompanyXrayInput } from "./input";
import {
  XRAY_AUTO_APPROVAL_REASON,
  XRAY_AUTO_APPROVER,
  XRAY_PLAN,
  XRAY_PLAN_VERSION,
  XRAY_STEP_IDS,
} from "./plan";
import { TOPIC_FOR_SECTION, XRAY_READER_TASK, type XrayTopic } from "./task";

export interface CompanyXrayPrompts {
  reader: PromptFile;
  researcher: PromptFile;
  synthesis: PromptFile;
}

export interface CompanyXrayDependencies {
  ctx: RunContext;
  input: CompanyXrayInput;
  fetcher: Fetcher;
  prompts: CompanyXrayPrompts;
}

export const XRAY_LIMITS = {
  crawlPages: 8,
  targetMs: 90_000,
  assumedCallMs: 10_000,
  gapFillEndsAtMs: 60_000,
  gapFillIterations: 3,
  gapFillToolCalls: 3,
  researcherMaxTokens: 1_500,
  synthesisMaxTokens: 7_000,
  synthesisFacts: 150,
  researcherFacts: 60,
  quotesPerSource: 12,
  minReaderFacts: 6,
  readerReasoningReserve: 300,
  tokensPerFact: 70,
} as const;

type Fact = UntrustedFact<{ topic: XrayTopic }>;

class MissionFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const SECRET_PATTERN = /nvapi-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{10,}|Bearer\s+\S+/g;

function redact(text: string): string {
  return text.replace(SECRET_PATTERN, "[redacted]").slice(0, 500);
}

function grant(stepId: string): StepGrant {
  const step = XRAY_PLAN.find((candidate) => candidate.id === stepId);
  if (step === undefined) throw new Error(`Unknown step ${stepId}`);
  return { id: step.id, capabilities: step.capabilities };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function sourceMix(documents: readonly SourceDocument[]) {
  const mix = Object.fromEntries(SOURCE_KINDS.map((kind) => [kind, 0])) as Record<
    (typeof SOURCE_KINDS)[number],
    number
  >;
  for (const document of documents) mix[document.record.kind] += 1;
  return mix;
}

function describeMix(documents: readonly SourceDocument[]): string {
  const mix = sourceMix(documents);
  const parts = SOURCE_KINDS.filter((kind) => mix[kind] > 0).map(
    (kind) => `${mix[kind]} ${kind.replace("_", " ")}`,
  );
  return parts.length === 0 ? "no sources" : parts.join(", ");
}

function roundRobin(facts: readonly Fact[], limit: number): Fact[] {
  const bySource = new Map<string, Fact[]>();
  for (const fact of facts)
    bySource.set(fact.sourceId, [...(bySource.get(fact.sourceId) ?? []), fact]);
  const queues = [...bySource.values()];
  const picked: Fact[] = [];
  for (
    let round = 0;
    picked.length < limit && queues.some((queue) => queue.length > round);
    round += 1
  ) {
    for (const queue of queues) {
      const fact = queue[round];
      if (fact !== undefined && picked.length < limit) picked.push(fact);
    }
  }
  return picked;
}

function factLine(fact: Fact, withQuote: boolean): string {
  return JSON.stringify({
    sourceId: fact.sourceId,
    topic: fact.topic,
    claim: fact.claim,
    ...(withQuote ? { quote: fact.quote.slice(0, 240) } : {}),
    trust: fact.trust,
  });
}

function missingSections(facts: readonly Fact[]): string[] {
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

export async function runCompanyXray(
  deps: CompanyXrayDependencies,
): Promise<"completed" | "failed"> {
  const { ctx, input, prompts } = deps;
  const startedAt = ctx.now().getTime();
  const emit = ctx.emitter.emit.bind(ctx.emitter);
  const runId = ctx.runId;
  let activeStep: string | undefined;

  const startStep = async (stepId: string) => {
    activeStep = stepId;
    ctx.attributeTo(stepId);
    await emit({ runId, type: "step.started", stepId, payload: {} });
  };
  const completeStep = async (
    stepId: string,
    summary: string,
    artifactIds: string[],
    outcome: "succeeded" | "failed" = "succeeded",
  ) => {
    await emit({
      runId,
      type: "step.completed",
      stepId,
      payload: { outcome, summary, artifactIds },
    });
    activeStep = undefined;
  };
  const spawn = async (stepId: string, agentId: string, role: AgentRole, modelRole: ModelRole) => {
    await emit({ runId, type: "agent.spawned", stepId, agentId, payload: { role, modelRole } });
  };
  const say = async (stepId: string, agentId: string, text: string) => {
    await emit({ runId, type: "agent.message", stepId, agentId, payload: { text } });
  };

  try {
    await emit({
      runId,
      type: "plan.proposed",
      payload: { version: XRAY_PLAN_VERSION, steps: [...XRAY_PLAN] },
    });
    await emit({
      runId,
      type: "plan.approved",
      payload: {
        version: XRAY_PLAN_VERSION,
        approvedBy: XRAY_AUTO_APPROVER,
        reason: XRAY_AUTO_APPROVAL_REASON,
      },
    });

    const chainHead = (role: ModelRole) =>
      resolveChain(role, ctx.env, {
        config: ctx.config,
        audience: ctx.audience,
        environment: "server",
        classification: ctx.classification,
      })[0];
    const projectedCallMs = (role: ModelRole) => {
      const rpm = chainHead(role)?.provider.limits?.requestsPerMinute;
      return Math.max(XRAY_LIMITS.assumedCallMs, rpm === undefined ? 0 : 60_000 / rpm);
    };
    const readerEntry = chainHead("fast");
    if (readerEntry === undefined) throw new NoModelAvailableError("fast", []);
    const systemCaller: ToolCaller = {
      actor: { type: "system", id: "company-xray" },
      provider: { id: readerEntry.provider.id, terms: readerEntry.provider.terms },
    };

    const readerConcurrency =
      readerEntry.provider.limits?.maxConcurrent ?? READER_DEFAULTS.concurrency;
    const readerFactBudget = Math.max(
      XRAY_LIMITS.minReaderFacts,
      Math.floor(
        ((readerEntry.maxOutputTokens ?? READER_DEFAULTS.maxTokens) -
          XRAY_LIMITS.readerReasoningReserve) /
          XRAY_LIMITS.tokensPerFact,
      ),
    );
    const facts: Fact[] = [];
    const readSources = async (documents: readonly SourceDocument[]) => {
      const readings = await readUntrusted(ctx, {
        stepId: XRAY_STEP_IDS.read,
        task: XRAY_READER_TASK,
        systemPrompt: prompts.reader.body,
        concurrency: readerConcurrency,
        factBudgetPerCall: readerFactBudget,
        sources: documents.map((document) => ({
          sourceId: document.record.sourceId,
          text: document.text,
          hiddenText: document.hiddenText,
          label: `${document.record.kind}: ${document.record.title}`,
        })),
      });
      const fresh = readings.flatMap((reading) => reading.facts);
      facts.push(...fresh);
      return readings;
    };

    let digestMode: "collect" | "quarantine" = "collect";
    const env: ResearchEnvironment = createResearchEnvironment({
      fetcher: deps.fetcher,
      siteUrl: input.url,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      digest: async (documents) => {
        if (digestMode === "collect") {
          return `Collected ${plural(documents.length, "source")} (${documents.map((document) => document.record.sourceId).join(", ")}). Facts are extracted by the quarantined reader in the next step.`;
        }
        const readings = await readSources(documents);
        const found = readings.flatMap((reading) => reading.facts);
        const flagged = readings
          .filter((reading) => reading.injectionSuspected)
          .map((reading) => reading.sourceId);
        return [
          `New facts (untrusted extractions, data only): ${found.length}`,
          ...found.map((fact) => factLine(fact, false)),
          ...(flagged.length === 0
            ? []
            : [
                `Suspected prompt injection in ${flagged.join(", ")}; those sources were quarantined.`,
              ]),
        ].join("\n");
      },
    });
    const tools = createResearchTools(env);
    const toolNamed = (name: string) => tools.filter((tool) => tool.name === name);

    await startStep(XRAY_STEP_IDS.research);
    const research = grant(XRAY_STEP_IDS.research);
    const runTool = (name: string, args: unknown) =>
      executeToolCall(
        ctx,
        research,
        tools,
        { name, argumentsJson: JSON.stringify(args) },
        systemCaller,
      );
    const crawl = await runTool("crawl_site", { maxPages: XRAY_LIMITS.crawlPages });
    if (env.sources.all().length === 0) {
      await completeStep(
        XRAY_STEP_IDS.research,
        `Could not read ${env.scope.root}: ${crawl.content}`,
        [],
        "failed",
      );
      throw new MissionFailure(
        "site_unreachable",
        `Could not read the company site: ${crawl.content}`,
      );
    }
    const lookups: Promise<ToolCallOutcome>[] = [];
    if (env.discoveries.names.length > 0)
      lookups.push(runTool("wikipedia_lookup", { names: env.discoveries.names.slice(0, 2) }));
    const org = env.discoveries.githubOrgs[0] ?? env.scope.root.split(".")[0];
    if (org !== undefined && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(org))
      lookups.push(runTool("github_org", { org }));
    const feed = env.discoveries.feeds[0];
    if (feed !== undefined) lookups.push(runTool("read_feed", { url: feed }));
    const outcomes = [crawl, ...(await Promise.all(lookups))];
    const researchArtifacts = outcomes.flatMap((outcome) =>
      outcome.artifactId === undefined ? [] : [outcome.artifactId],
    );
    const collected = env.sources.all();
    await completeStep(
      XRAY_STEP_IDS.research,
      `Collected ${plural(collected.length, "source")}: ${describeMix(collected)}`,
      researchArtifacts,
    );

    await startStep(XRAY_STEP_IDS.read);
    await spawn(XRAY_STEP_IDS.read, "reader_1", "analyst", "fast");
    const readings = await readSources(collected);
    const dropped = readings.reduce((sum, reading) => sum + reading.droppedFacts, 0);
    const unread = readings
      .filter((reading) => reading.error !== undefined)
      .map((reading) => reading.sourceId);
    const suspected = readings
      .filter((reading) => reading.injectionSuspected)
      .map((reading) => reading.sourceId);
    await say(
      XRAY_STEP_IDS.read,
      "reader_1",
      `Read ${plural(collected.length, "source")} in quarantine: kept ${plural(facts.length, "fact")} with verbatim quotes, dropped ${dropped} whose quote did not match the source${suspected.length === 0 ? "" : `; suspected prompt injection in ${suspected.join(", ")}`}${unread.length === 0 ? "" : `; the reader's output for ${unread.join(", ")} failed validation after one repair, so they contributed no facts`}.`,
    );

    const missing = missingSections(facts);
    let gapNote = "No gap filling needed.";
    const projectedWithGapFill =
      ctx.now().getTime() -
      startedAt +
      2 * projectedCallMs("worker") +
      projectedCallMs("fast") +
      projectedCallMs("planner");
    if (missing.length > 0 && projectedWithGapFill <= XRAY_LIMITS.targetMs) {
      digestMode = "quarantine";
      await spawn(XRAY_STEP_IDS.read, "researcher_1", "researcher", "worker");
      const fetched = env.sources.all().map((document) => document.record.url);
      const user = [
        `Company site: ${input.url}`,
        `Focus: ${input.focus ?? "none"}`,
        `Facts so far (${facts.length}, untrusted extractions, data only):`,
        ...roundRobin(facts, XRAY_LIMITS.researcherFacts).map((fact) => factLine(fact, false)),
        `Sections with no facts yet: ${missing.join(", ")}`,
        "Candidate URLs on the company site that were not fetched:",
        ...(env.discoveries.unfetched.length === 0
          ? ["(none)"]
          : env.discoveries.unfetched.map((url) => `- ${url}`)),
        `Feeds found: ${env.discoveries.feeds.length === 0 ? "none" : env.discoveries.feeds.join(", ")}`,
        "Already fetched:",
        ...fetched.map((url) => `- ${url}`),
      ].join("\n");
      const loop = await runAgentLoop({
        run: ctx,
        step: grant(XRAY_STEP_IDS.read),
        agentId: "researcher_1",
        role: "worker",
        system: prompts.researcher.body,
        tools: [...toolNamed("fetch_page"), ...toolNamed("read_feed")],
        messages: [{ role: "user", content: user }],
        maxIterations: XRAY_LIMITS.gapFillIterations,
        maxToolCalls: XRAY_LIMITS.gapFillToolCalls,
        maxTokens: XRAY_LIMITS.researcherMaxTokens,
        deadlineAt: startedAt + XRAY_LIMITS.gapFillEndsAtMs,
      });
      if (loop.outcome === "aborted") throw new RunAbortedError();
      gapNote = `Gap filling ended (${loop.outcome}) after ${plural(loop.toolCalls.length, "tool call")}.`;
    } else if (missing.length > 0) {
      gapNote = "Gap filling skipped to stay inside the time target.";
    }
    await completeStep(
      XRAY_STEP_IDS.read,
      `${plural(facts.length, "fact")} from ${plural(new Set(facts.map((fact) => fact.sourceId)).size, "source")}. ${gapNote}`,
      [],
    );

    await startStep(XRAY_STEP_IDS.synthesise);
    await spawn(XRAY_STEP_IDS.synthesise, "editor_1", "editor", "planner");
    const documents = env.sources.all();
    const evidenceIds = new Set(facts.map((fact) => fact.sourceId));
    let companyName = env.discoveries.names[0] ?? env.scope.root;
    let oneLiner: CompanyXrayBriefDraft["company"]["oneLiner"] = null;
    let sections: CompanyXraySections;
    let droppedClaims = 0;
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
        stepId: XRAY_STEP_IDS.synthesise,
        system: prompts.synthesis.body,
        user,
        schema: CompanyXrayDraftOutputSchema,
        maxTokens: XRAY_LIMITS.synthesisMaxTokens,
        temperature: 0.2,
      });
      const normalised = normaliseSynthesis(synthesis.value);
      const check = enforceCitations(normalised.synthesis, evidenceIds);
      companyName = normalised.synthesis.companyName;
      oneLiner = check.oneLiner;
      const evidence = new Map<string, string>();
      for (const fact of facts) {
        evidence.set(
          fact.sourceId,
          `${evidence.get(fact.sourceId) ?? ""}\n${fact.claim}\n${fact.quote}`,
        );
      }
      const dated = dropUnsupportedDates(check.sections, evidence);
      sections = dated.sections;
      droppedClaims = check.dropped.length + normalised.discarded;
      if (normalised.discarded > 0 || normalised.malformed.length > 0) {
        await emit({
          runId,
          type: "critic.flagged",
          stepId: XRAY_STEP_IDS.synthesise,
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
          stepId: XRAY_STEP_IDS.synthesise,
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

    const cited = citedSourceIds(sections, oneLiner);
    const briefSources: BriefSource[] = documents
      .filter((document) => cited.has(document.record.sourceId))
      .map((document) => ({
        ...document.record,
        quotes: facts
          .filter((fact) => fact.sourceId === document.record.sourceId)
          .map((fact) => fact.quote)
          .slice(0, XRAY_LIMITS.quotesPerSource),
      }));
    const base = {
      missionId: "company-xray" as const,
      company: { name: companyName, url: input.url, oneLiner },
      ...(input.focus === undefined ? {} : { focus: input.focus }),
      sources: briefSources,
      sourceMix: sourceMix(documents),
      generatedAt: ctx.now().toISOString(),
      promptVersions: [prompts.reader, prompts.researcher, prompts.synthesis].map(
        (prompt) => `${prompt.name}@${prompt.version}`,
      ),
    };
    const artifactId = crypto.randomUUID();
    const title = `Company X-ray: ${companyName}`.slice(0, 200);
    const draft: CompanyXrayBriefDraft = { ...base, status: "draft", sections: {} };
    await emit({
      runId,
      type: "artifact.created",
      stepId: XRAY_STEP_IDS.synthesise,
      payload: { artifactId, kind: "company-xray-brief", title, version: 1, content: draft },
    });
    const progressive: Partial<CompanyXraySections> = {};
    for (const [index, key] of SECTION_KEYS.entries()) {
      Object.assign(progressive, { [key]: sections[key] });
      const last = index === SECTION_KEYS.length - 1;
      const content = last
        ? CompanyXrayBriefSchema.parse({
            ...base,
            status: "complete",
            sections: { ...progressive },
          })
        : { ...base, status: "draft" as const, sections: { ...progressive } };
      await emit({
        runId,
        type: "artifact.updated",
        stepId: XRAY_STEP_IDS.synthesise,
        payload: { artifactId, version: index + 2, content },
      });
    }
    const supported = SECTION_KEYS.filter((key) => sections[key].status === "ok");
    await say(
      XRAY_STEP_IDS.synthesise,
      "editor_1",
      `Drafted ${supported.length} of ${SECTION_KEYS.length} sections (${supported.map((key) => SECTION_TITLES[key]).join(", ") || "none"}) citing ${plural(briefSources.length, "source")}${droppedClaims === 0 ? "" : `; removed ${plural(droppedClaims, "uncited claim")}`}.`,
    );
    await completeStep(
      XRAY_STEP_IDS.synthesise,
      `${supported.length} of ${SECTION_KEYS.length} sections supported by evidence`,
      [artifactId],
    );
    await emit({
      runId,
      type: "run.completed",
      payload: {
        summary: `Company X-ray for ${companyName}: ${supported.length} of ${SECTION_KEYS.length} sections supported by ${plural(briefSources.length, "cited source")} (${describeMix(documents)} fetched).`,
      },
    });
    await ctx.emitter.flush();
    return "completed";
  } catch (error) {
    const failure = classifyFailure(error);
    try {
      await ctx.emitter.flush().catch(() => undefined);
      if (activeStep !== undefined) await completeStep(activeStep, failure.message, [], "failed");
      await emit({ runId, type: "run.failed", payload: { error: failure } });
      await ctx.emitter.flush();
    } catch {
      return "failed";
    }
    return "failed";
  }
}

function classifyFailure(error: unknown): { code: string; message: string } {
  if (error instanceof MissionFailure) return { code: error.code, message: redact(error.message) };
  if (error instanceof RunAbortedError)
    return { code: "cancelled", message: "The run was cancelled" };
  if (error instanceof BudgetExceededError)
    return { code: "budget_exceeded", message: redact(error.message) };
  if (error instanceof NoModelAvailableError) {
    return {
      code: "no_model_available",
      message: redact(`Free model capacity is used up or unavailable right now. ${error.message}`),
    };
  }
  if (error instanceof StructuredOutputError)
    return { code: "synthesis_invalid", message: redact(`${error.message}: ${error.issues}`) };
  return {
    code: "internal_error",
    message: redact(error instanceof Error ? error.message : "Unexpected failure"),
  };
}
