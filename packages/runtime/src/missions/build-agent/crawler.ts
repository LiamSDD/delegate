import { CAPABILITIES } from "@delegate/policy";
import { z } from "zod";

import { type RunContext } from "../../agent/context";
import { chainHead } from "../../agent/pacing";
import { type CrawlCheckpoint, type CrawlStateArtifact } from "../../crawl/checkpoint";
import {
  crawl,
  crawlStateArtifact,
  formatProgress,
  type CrawlPage,
  type CrawlProgress,
} from "../../crawl/engine";
import { DOCS_PROFILE } from "../../crawl/priority";
import { chunkPage } from "../../knowledge/chunker";
import { type KnowledgeStore, type StoredPage } from "../../knowledge/types";
import { detectInjection } from "../../quarantine/reader";
import { type FetchedDocument, type Fetcher } from "../../tools/fetch";
import { defineTool, executeToolCall, type StepGrant } from "../../tools/registry";
import { siteScope } from "../../tools/research";
import { type CrawlReport } from "./schema";

export const CRAWL_LIMITS = {
  maxPages: 300,
  maxBytes: 60 * 1024 * 1024,
  maxDurationMs: 120_000,
  maxDepth: 6,
  maxQueue: 3_000,
  maxSitemapFetches: 12,
  maxSitemapUrls: 5_000,
  minTextChars: 40,
  maxLinksPerPage: 200,
  maxPerPattern: 60,
  concurrency: 32,
  checkpointEveryPages: 60,
  progressEveryMs: 4_000,
  maxStoredLinks: 500,
  maxSkippedReported: 200,
} as const;

export type CrawlLimits = { [K in keyof typeof CRAWL_LIMITS]: number };

export interface CrawlOptions {
  ctx: RunContext;
  grant: StepGrant;
  fetcher: Fetcher;
  knowledge: KnowledgeStore;
  collection: string;
  startUrl: string;
  limits?: Partial<CrawlLimits>;
  checkpoint?: CrawlCheckpoint;
  onCheckpoint?: (state: CrawlStateArtifact) => Promise<void>;
  onProgress?: (text: string, progress: CrawlProgress) => Promise<void>;
}

interface Recorded {
  page: StoredPage;
  cached: boolean;
  flagged: number;
}

export async function crawlSite(options: CrawlOptions): Promise<CrawlReport> {
  const { ctx, knowledge, collection } = options;
  const limits: CrawlLimits = { ...CRAWL_LIMITS, ...options.limits };
  const startedAt = ctx.now().getTime();
  const start = new URL(options.startUrl);
  const scope = siteScope(options.startUrl);
  const documents = new Map<string, FetchedDocument>();
  const failures = new Map<string, Error>();
  const tool = defineTool({
    name: "crawl_page",
    description: "Fetch one page of the company's own site for indexing.",
    capability: CAPABILITIES.webFetch,
    inputSchema: z.object({ url: z.url() }),
    targetDomain: (input) => new URL(input.url).hostname,
    summariseArgs: (input) => input.url,
    execute: async (input) => {
      try {
        const document = await options.fetcher.fetch({
          url: input.url,
          ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        });
        documents.set(input.url, document);
        return {
          summary: `${document.status} ${document.contentType} ${document.bytes} bytes${document.truncated === true ? " (truncated)" : ""}`,
          forModel: "",
        };
      } catch (error) {
        failures.set(input.url, error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    },
  });
  const caller = () => {
    const head = chainHead(ctx, "fast");
    return {
      actor: { type: "system" as const, id: "build-agent" },
      ...(head === undefined
        ? {}
        : { provider: { id: head.provider.id, terms: head.provider.terms } }),
    };
  };
  const fetchVia = async (url: string): Promise<FetchedDocument> => {
    const outcome = await executeToolCall(
      ctx,
      options.grant,
      [tool],
      { name: tool.name, argumentsJson: JSON.stringify({ url }) },
      caller(),
    );
    const document = documents.get(url);
    documents.delete(url);
    if (outcome.ok && document !== undefined) return document;
    const failure = failures.get(url);
    failures.delete(url);
    throw failure ?? new Error(outcome.content.slice(0, 200));
  };

  const recorded = new Map<string, Recorded>();
  const cachedPages = new Map<string, StoredPage>();
  let flaggedByDocument: Promise<Map<string, number>> | undefined;
  const flaggedFor = async (documentId: string): Promise<number> => {
    flaggedByDocument ??= knowledge.listChunks(collection).then((chunks) => {
      const counts = new Map<string, number>();
      for (const chunk of chunks)
        if (chunk.flagged) counts.set(chunk.documentId, (counts.get(chunk.documentId) ?? 0) + 1);
      return counts;
    });
    return (await flaggedByDocument).get(documentId) ?? 0;
  };

  const store = async (page: CrawlPage): Promise<boolean> => {
    if (page.kind === "cached") {
      const stored = cachedPages.get(page.entry.url);
      if (stored === undefined) return false;
      recorded.set(page.entry.url, {
        page: stored,
        cached: true,
        flagged: await flaggedFor(stored.documentId),
      });
      return true;
    }
    const chunks = chunkPage(page.text).map((chunk) => ({
      ...chunk,
      flagged: detectInjection(chunk.text) !== undefined,
    }));
    if (chunks.length === 0) return false;
    const links = page.page.links
      .map((link) => link.href)
      .filter((href) => scope.contains(href))
      .slice(0, limits.maxStoredLinks);
    const stored = await knowledge.putPage({
      collection,
      url: page.entry.url,
      title: (page.page.title || page.finalUrl).slice(0, 300),
      contentHash: page.contentHash,
      fetchedAt: page.document.fetchedAt,
      bytes: page.document.bytes,
      links,
      chunks,
    });
    recorded.set(page.entry.url, {
      page: stored,
      cached: false,
      flagged: chunks.filter((chunk) => chunk.flagged).length,
    });
    return true;
  };

  const result = await crawl({
    fetcher: options.fetcher,
    fetch: ({ url }) => fetchVia(url),
    seeds: [start.href],
    scope: (url) => scope.contains(url),
    profile: DOCS_PROFILE,
    concurrency: limits.concurrency,
    budget: {
      maxPages: limits.maxPages,
      maxBytes: limits.maxBytes,
      maxDurationMs: limits.maxDurationMs,
      maxDepth: limits.maxDepth,
      maxQueue: limits.maxQueue,
      maxSitemapFetches: limits.maxSitemapFetches,
      maxSitemapUrls: limits.maxSitemapUrls,
      minTextChars: limits.minTextChars,
      maxLinksPerPage: limits.maxLinksPerPage,
      maxPerPattern: limits.maxPerPattern,
    },
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    ...(options.checkpoint === undefined ? {} : { checkpoint: options.checkpoint }),
    cached: async (url) => {
      const stored = await knowledge.getPage(collection, url);
      if (stored === null) return undefined;
      cachedPages.set(url, stored);
      return { title: stored.title, links: stored.links, contentHash: stored.contentHash };
    },
    onPage: store,
    progressEveryMs: limits.progressEveryMs,
    ...(options.onProgress === undefined
      ? {}
      : {
          onProgress: (progress: CrawlProgress) =>
            options.onProgress?.(formatProgress(progress), progress),
        }),
    checkpointEveryPages: limits.checkpointEveryPages,
    ...(options.onCheckpoint === undefined
      ? {}
      : {
          onCheckpoint: (checkpoint: CrawlCheckpoint, progress: CrawlProgress) =>
            options.onCheckpoint?.(crawlStateArtifact(start.href, checkpoint, progress)) ??
            Promise.resolve(),
        }),
  });

  const pages: CrawlReport["pages"] = [];
  for (const record of result.pages) {
    let entry = recorded.get(record.url);
    if (entry === undefined) {
      const stored = await knowledge.getPage(collection, record.url);
      if (stored === null) continue;
      entry = { page: stored, cached: true, flagged: await flaggedFor(stored.documentId) };
    }
    pages.push({
      url: entry.page.url,
      title: entry.page.title,
      documentId: entry.page.documentId,
      chunks: entry.page.chunkCount,
      flaggedChunks: entry.flagged,
      cached: entry.cached,
    });
  }
  return {
    collection,
    startUrl: start.href,
    pages,
    skipped: result.skipped.slice(0, limits.maxSkippedReported).map((skip) => ({
      url: skip.url,
      reason: `${skip.code}: ${skip.reason}`.slice(0, 200),
    })),
    bytes: result.stats.bytes,
    sitemapUrls: result.stats.sitemapUrls,
    durationMs: Math.max(0, ctx.now().getTime() - startedAt),
  };
}
