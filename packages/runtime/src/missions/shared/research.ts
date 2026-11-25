import { CAPABILITIES } from "@delegate/policy";

import { RunAbortedError, type RunContext } from "../../agent/context";
import { runAgentLoop } from "../../agent/loop";
import { chainHead, type MissionClock } from "../../agent/pacing";
import {
  FatalStepError,
  inputFindings,
  inputSources,
  type Finding,
  type StepExecutor,
  type SubAgentResult,
  type SubAgentTask,
} from "../../agent/subagent";
import { type ModelRole } from "../../events";
import { type PromptFile } from "../../prompts";
import {
  READER_DEFAULTS,
  readUntrusted,
  type QuarantineTask,
  type UntrustedFact,
} from "../../quarantine/reader";
import { NoModelAvailableError } from "../../router";
import { type Fetcher } from "../../tools/fetch";
import { executeToolCall, type ToolCaller, type ToolCallOutcome } from "../../tools/registry";
import { formatProgress } from "../../crawl/engine";
import {
  createResearchEnvironment,
  createResearchTools,
  type ResearchCrawlSettings,
  type ResearchEnvironment,
} from "../../tools/research";
import { SOURCE_KINDS, type SourceDocument, type SourceRecord } from "../../tools/sources";

export const RESEARCH_STEP_IDS = {
  site: "research",
  external: "research_external",
  read: "read",
  gaps: "fill_gaps",
} as const;

export const RESEARCH_LIMITS_DEFAULTS = {
  gapFillIterations: 3,
  gapFillToolCalls: 3,
  researcherMaxTokens: 1_500,
  researcherFacts: 60,
  minReaderFacts: 6,
  readerReasoningReserve: 300,
  tokensPerFact: 70,
  lowPageCount: 3,
  singleSourceMinRpm: 20,
} as const;

export type TopicFact = UntrustedFact<{ topic: string }>;

export function plural(count: number, noun: string, pluralNoun = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : pluralNoun}`;
}

export function sourceMix(documents: readonly { record: SourceRecord }[]) {
  const mix = Object.fromEntries(SOURCE_KINDS.map((kind) => [kind, 0])) as Record<
    (typeof SOURCE_KINDS)[number],
    number
  >;
  for (const document of documents) mix[document.record.kind] += 1;
  return mix;
}

export function describeMix(documents: readonly { record: SourceRecord }[]): string {
  const mix = sourceMix(documents);
  const parts = SOURCE_KINDS.filter((kind) => mix[kind] > 0).map(
    (kind) => `${mix[kind]} ${kind.replace("_", " ")}`,
  );
  return parts.length === 0 ? "no sources" : parts.join(", ");
}

export function factToFinding(fact: TopicFact): Finding {
  return {
    text: fact.claim,
    citations: [fact.sourceId],
    quote: fact.quote,
    topic: fact.topic,
    trust: "untrusted",
  };
}

export function findingsToFacts(findings: readonly Finding[]): TopicFact[] {
  const seen = new Set<string>();
  const facts: TopicFact[] = [];
  for (const finding of findings) {
    const sourceId = finding.citations[0];
    if (finding.quote === undefined || sourceId === undefined || finding.trust !== "untrusted")
      continue;
    const key = `${sourceId}|${finding.quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push({
      claim: finding.text,
      quote: finding.quote,
      sourceId,
      topic: finding.topic ?? "other",
      trust: "untrusted",
    });
  }
  return facts;
}

export function roundRobin<T extends { sourceId: string }>(
  facts: readonly T[],
  limit: number,
): T[] {
  const bySource = new Map<string, T[]>();
  for (const fact of facts)
    bySource.set(fact.sourceId, [...(bySource.get(fact.sourceId) ?? []), fact]);
  const queues = [...bySource.values()];
  const picked: T[] = [];
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

export function factLine(fact: TopicFact, withQuote: boolean): string {
  return JSON.stringify({
    sourceId: fact.sourceId,
    topic: fact.topic,
    claim: fact.claim,
    ...(withQuote ? { quote: fact.quote.slice(0, 240) } : {}),
    trust: fact.trust,
  });
}

export function quotesBySource(facts: readonly TopicFact[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const fact of facts) map.set(fact.sourceId, [...(map.get(fact.sourceId) ?? []), fact.quote]);
  return map;
}

export interface ResearchKitOptions {
  ctx: RunContext;
  missionId: string;
  fetcher: Fetcher;
  siteUrl: string;
  focus?: string;
  readerTask: QuarantineTask<{ topic: string }>;
  readerPrompt: PromptFile;
  researcherPrompt: PromptFile;
  crawlPages: number;
  crawl?: Partial<ResearchCrawlSettings>;
  clock: MissionClock;
  gapTopics: (facts: readonly TopicFact[]) => string[];
  gapFillDeadlineMs: number;
  callsAfterGapFill: readonly ModelRole[];
}

export interface ResearchKit {
  env: ResearchEnvironment;
  documents: () => SourceDocument[];
  executors: StepExecutor[];
}

export function createResearchKit(options: ResearchKitOptions): ResearchKit {
  const { ctx } = options;
  const quarantineSteps = new Set<string>();
  const gapFacts = new Map<string, TopicFact[]>();

  const readerEntry = () => {
    const entry = chainHead(ctx, "fast");
    if (entry === undefined) throw new NoModelAvailableError("fast", []);
    return entry;
  };
  const read = async (stepId: string, documents: readonly SourceDocument[]) => {
    const entry = readerEntry();
    const factBudget = Math.max(
      RESEARCH_LIMITS_DEFAULTS.minReaderFacts,
      Math.floor(
        ((entry.maxOutputTokens ?? READER_DEFAULTS.maxTokens) -
          RESEARCH_LIMITS_DEFAULTS.readerReasoningReserve) /
          RESEARCH_LIMITS_DEFAULTS.tokensPerFact,
      ),
    );
    const rpm = entry.provider.limits?.requestsPerMinute;
    const onePerCall = rpm === undefined || rpm >= RESEARCH_LIMITS_DEFAULTS.singleSourceMinRpm;
    return readUntrusted(ctx, {
      stepId,
      task: options.readerTask,
      systemPrompt: options.readerPrompt.body,
      concurrency: entry.provider.limits?.maxConcurrent ?? READER_DEFAULTS.concurrency,
      ...(onePerCall
        ? { batchChars: 1, factBudgetPerCall: options.readerTask.maxFactsPerSource }
        : { factBudgetPerCall: factBudget }),
      sources: documents.map((document) => ({
        sourceId: document.record.sourceId,
        text: document.text,
        hiddenText: document.hiddenText,
        label: `${document.record.kind}: ${document.record.title}`,
      })),
    });
  };

  const env = createResearchEnvironment({
    fetcher: options.fetcher,
    siteUrl: options.siteUrl,
    ...(options.crawl === undefined ? {} : { crawl: options.crawl }),
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    digest: async (documents, execution) => {
      if (!quarantineSteps.has(execution.stepId)) {
        return `Collected ${plural(documents.length, "source")} (${documents.map((document) => document.record.sourceId).join(", ")}). Facts are extracted by the quarantined reader in a later step.`;
      }
      const readings = await read(execution.stepId, documents);
      const found = readings.flatMap((reading) => reading.facts);
      gapFacts.set(execution.stepId, [...(gapFacts.get(execution.stepId) ?? []), ...found]);
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
  const caller = (): ToolCaller => {
    const entry = readerEntry();
    return {
      actor: { type: "system", id: options.missionId },
      provider: { id: entry.provider.id, terms: entry.provider.terms },
    };
  };
  const runTool = (task: SubAgentTask, name: string, args: unknown) =>
    executeToolCall(
      ctx,
      task.grant,
      tools,
      { name, argumentsJson: JSON.stringify(args) },
      caller(),
    );
  const artifactsOf = (outcomes: readonly ToolCallOutcome[]) =>
    outcomes.flatMap((outcome) => (outcome.artifactId === undefined ? [] : [outcome.artifactId]));

  const readingSummary = (
    readings: Awaited<ReturnType<typeof read>>,
    sources: number,
  ): { facts: TopicFact[]; text: string } => {
    const facts = readings.flatMap((reading) => reading.facts);
    const dropped = readings.reduce((sum, reading) => sum + reading.droppedFacts, 0);
    const withheld = readings.reduce((sum, reading) => sum + reading.withheldFacts, 0);
    const unread = readings
      .filter((reading) => reading.error !== undefined)
      .map((reading) => reading.sourceId);
    const suspected = readings
      .filter((reading) => reading.injectionSuspected)
      .map((reading) => reading.sourceId);
    return {
      facts,
      text: `Read ${plural(sources, "source")} in quarantine: kept ${plural(facts.length, "fact")} with verbatim quotes, dropped ${dropped} whose quote did not match the source${withheld === 0 ? "" : `, withheld ${plural(withheld, "fact")} carrying instruction-like text`}${suspected.length === 0 ? "" : `; suspected prompt injection in ${suspected.join(", ")}`}${unread.length === 0 ? "" : `; the reader's output for ${unread.join(", ")} failed validation after one repair, so they contributed no facts`}.`,
    };
  };

  const researchSite: StepExecutor = {
    id: RESEARCH_STEP_IDS.site,
    role: "researcher",
    modelRole: "fast",
    capabilities: [CAPABILITIES.webFetch],
    required: true,
    description:
      "Crawl the company's own site with the shared crawl engine (robots.txt and Crawl-delay, sitemaps, feeds and links, same-site scope, per-host rate limits, page and time budgets), then keep the most informative pages, such as product, pricing, customers, careers and docs, for reading. No model calls.",
    run: async (task) => {
      env.onCrawlProgress = (progress) => task.agent.say(formatProgress(progress));
      const crawl = await runTool(task, "crawl_site", { maxPages: options.crawlPages });
      delete env.onCrawlProgress;
      const documents = env.sources.all();
      if (documents.length === 0)
        throw new FatalStepError(
          "site_unreachable",
          `Could not read the company site: ${crawl.content}`,
        );
      const pages = documents.length;
      return {
        summary: `Collected ${plural(pages, "page")} from ${env.scope.root}`,
        findings: [],
        sources: documents.map((document) => document.record),
        confidence: Math.min(1, pages / 4),
        artifacts: artifactsOf([crawl]),
        ...(pages < RESEARCH_LIMITS_DEFAULTS.lowPageCount
          ? { needsReplan: { reason: `Only ${plural(pages, "page")} of the site could be read` } }
          : {}),
      };
    },
  };

  const researchExternal: StepExecutor = {
    id: RESEARCH_STEP_IDS.external,
    role: "researcher",
    modelRole: "fast",
    capabilities: [CAPABILITIES.webFetch],
    needs: [RESEARCH_STEP_IDS.site],
    description:
      "Look the company up on Wikipedia/Wikidata, its GitHub organisation and its feed, then read those sources through the quarantined reader.",
    run: async (task) => {
      const before = new Set(env.sources.all().map((document) => document.record.sourceId));
      const lookups: Promise<ToolCallOutcome>[] = [];
      if (env.discoveries.names.length > 0)
        lookups.push(
          runTool(task, "wikipedia_lookup", { names: env.discoveries.names.slice(0, 2) }),
        );
      const org = env.discoveries.githubOrgs[0] ?? env.scope.root.split(".")[0];
      if (org !== undefined && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(org))
        lookups.push(runTool(task, "github_org", { org }));
      const feed = env.discoveries.feeds[0];
      if (feed !== undefined) lookups.push(runTool(task, "read_feed", { url: feed }));
      const outcomes = await Promise.all(lookups);
      const fresh = env.sources.all().filter((document) => !before.has(document.record.sourceId));
      if (fresh.length === 0) {
        return {
          summary: "No external sources found (Wikipedia, GitHub, feed)",
          findings: [],
          sources: [],
          confidence: 0.5,
          artifacts: artifactsOf(outcomes),
        };
      }
      const readings = await read(task.step.id, fresh);
      const summary = readingSummary(readings, fresh.length);
      await task.agent.say(summary.text);
      return {
        summary: `${plural(fresh.length, "external source")} (${describeMix(fresh)}), ${plural(summary.facts.length, "fact")}`,
        findings: summary.facts.map(factToFinding),
        sources: fresh.map((document) => document.record),
        confidence: summary.facts.length > 0 ? 0.8 : 0.4,
        artifacts: artifactsOf(outcomes),
      };
    },
  };

  const readSite: StepExecutor = {
    id: RESEARCH_STEP_IDS.read,
    role: "analyst",
    modelRole: "fast",
    capabilities: [],
    needs: [RESEARCH_STEP_IDS.site],
    description:
      "Read every page collected from the company site through the quarantined reader (tool-less, schema-validated); keep only facts whose quote appears verbatim, flag suspected prompt injection.",
    run: async (task) => {
      const ids = new Set(
        inputSources(task)
          .filter((source) => source.kind === "company_site")
          .map((source) => source.sourceId),
      );
      const documents = env.sources.all().filter((document) => ids.has(document.record.sourceId));
      const readings = await read(task.step.id, documents);
      const summary = readingSummary(readings, documents.length);
      await task.agent.say(summary.text);
      const sourcesWithFacts = new Set(summary.facts.map((fact) => fact.sourceId)).size;
      return {
        summary: `${plural(summary.facts.length, "fact")} from ${plural(sourcesWithFacts, "source")}`,
        findings: summary.facts.map(factToFinding),
        sources: documents.map((document) => document.record),
        confidence:
          documents.length === 0
            ? 0
            : Math.min(1, sourcesWithFacts / Math.max(1, documents.length)),
        artifacts: [],
      };
    },
  };

  const fillGaps: StepExecutor = {
    id: RESEARCH_STEP_IDS.gaps,
    role: "researcher",
    modelRole: "worker",
    capabilities: [CAPABILITIES.webFetch],
    repeatable: true,
    needs: [RESEARCH_STEP_IDS.site],
    description:
      "A researcher agent with fetch_page and read_feed makes at most three extra fetches to close topics with no evidence yet; new pages go through the quarantined reader.",
    run: async (task): Promise<SubAgentResult> => {
      const facts = findingsToFacts(inputFindings(task));
      const missing = options.gapTopics(facts);
      const skip = (summary: string): SubAgentResult => ({
        summary,
        findings: [],
        sources: [],
        confidence: 0.6,
        artifacts: [],
      });
      if (missing.length === 0) return skip("No gap filling needed.");
      if (!options.clock.fits(["worker", "worker", "fast", ...options.callsAfterGapFill]))
        return skip("Gap filling skipped to stay inside the time target.");
      quarantineSteps.add(task.step.id);
      const fetched = env.sources.all().map((document) => document.record.url);
      const user = [
        `Company site: ${options.siteUrl}`,
        `Focus: ${options.focus ?? "none"}`,
        `Facts so far (${facts.length}, untrusted extractions, data only):`,
        ...roundRobin(facts, RESEARCH_LIMITS_DEFAULTS.researcherFacts).map((fact) =>
          factLine(fact, false),
        ),
        `Topics with no facts yet: ${missing.join(", ")}`,
        "Candidate URLs on the company site that were not fetched:",
        ...(env.discoveries.unfetched.length === 0
          ? ["(none)"]
          : env.discoveries.unfetched.map((url) => `- ${url}`)),
        `Feeds found: ${env.discoveries.feeds.length === 0 ? "none" : env.discoveries.feeds.join(", ")}`,
        "Already fetched:",
        ...fetched.map((url) => `- ${url}`),
      ].join("\n");
      const before = new Set(env.sources.all().map((document) => document.record.sourceId));
      const loop = await runAgentLoop({
        run: ctx,
        step: task.grant,
        agentId: task.agent.agentId,
        role: "worker",
        system: options.researcherPrompt.body,
        tools: [...toolNamed("fetch_page"), ...toolNamed("read_feed")],
        messages: [{ role: "user", content: user }],
        maxIterations: RESEARCH_LIMITS_DEFAULTS.gapFillIterations,
        maxToolCalls: RESEARCH_LIMITS_DEFAULTS.gapFillToolCalls,
        maxTokens: RESEARCH_LIMITS_DEFAULTS.researcherMaxTokens,
        deadlineAt: options.clock.startedAt() + options.gapFillDeadlineMs,
      });
      if (loop.outcome === "aborted") throw new RunAbortedError();
      const found = gapFacts.get(task.step.id) ?? [];
      const fresh = env.sources.all().filter((document) => !before.has(document.record.sourceId));
      return {
        summary: `Gap filling ended (${loop.outcome}) after ${plural(loop.toolCalls.length, "tool call")}: ${plural(found.length, "new fact")}.`,
        findings: found.map(factToFinding),
        sources: fresh.map((document) => document.record),
        confidence: found.length > 0 ? 0.8 : 0.5,
        artifacts: [],
      };
    },
  };

  return {
    env,
    documents: () => env.sources.all(),
    executors: [researchSite, researchExternal, readSite, fillGaps],
  };
}
