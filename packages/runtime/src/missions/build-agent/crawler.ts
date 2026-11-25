import { createHash } from "node:crypto";

import { CAPABILITIES } from "@delegate/policy";
import { z } from "zod";

import { type RunContext } from "../../agent/context";
import { chainHead } from "../../agent/pacing";
import { chunkPage } from "../../knowledge/chunker";
import { type KnowledgeStore, type StoredPage } from "../../knowledge/types";
import { detectInjection } from "../../quarantine/reader";
import { FetchBlockedError, type FetchedDocument, type Fetcher } from "../../tools/fetch";
import { htmlToText } from "../../tools/html";
import { defineTool, executeToolCall, type StepGrant } from "../../tools/registry";
import { siteScope } from "../../tools/research";
import { normaliseUrlKey } from "../../tools/sources";
import { parseSitemap } from "../../tools/xml";
import { type CrawlReport } from "./schema";

export const CRAWL_LIMITS = {
  maxPages: 60,
  maxBytes: 5 * 1024 * 1024,
  maxDurationMs: 110_000,
  maxSitemapFetches: 3,
  maxSitemapUrls: 400,
  maxQueue: 600,
  minTextChars: 40,
  maxLinksPerPage: 200,
} as const;

export type CrawlLimits = { [K in keyof typeof CRAWL_LIMITS]: number };

const BINARY_EXTENSION =
  /\.(png|jpe?g|gif|svg|webp|avif|ico|bmp|tiff?|pdf|docx?|xlsx?|pptx?|zip|gz|tgz|rar|7z|dmg|exe|msi|apk|mp4|mov|avi|webm|mp3|wav|ogg|css|js|mjs|map|json|xml|txt|rss|atom|woff2?|ttf|otf|eot)$/i;
const EXCLUDED_SEGMENT =
  /^(login|log-in|signin|sign-in|signup|sign-up|register|logout|cart|checkout|account|my-account|wp-admin|wp-login\.php|wp-json|cdn-cgi|search|feed|tag|tags|author|print|share)$/i;
const LOCALE_SEGMENT = /^[a-z]{2}([-_][a-z]{2})?$/i;
const ENGLISH_LOCALE = /^en([-_][a-z]{2})?$/i;

export interface CrawlOptions {
  ctx: RunContext;
  grant: StepGrant;
  fetcher: Fetcher;
  knowledge: KnowledgeStore;
  collection: string;
  startUrl: string;
  limits?: Partial<CrawlLimits>;
}

export function canonicalUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    url.hash = "";
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.href;
  } catch {
    return undefined;
  }
}

function firstSegment(url: URL): string | undefined {
  return url.pathname.split("/").find((segment) => segment !== "");
}

export function crawlEligible(raw: string, start: URL, inScope: (url: string) => boolean): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.search !== "" || url.username !== "" || url.password !== "") return false;
  if (!inScope(url.href)) return false;
  if (BINARY_EXTENSION.test(url.pathname)) return false;
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  if (segments.some((segment) => EXCLUDED_SEGMENT.test(segment))) return false;
  const locale = firstSegment(url);
  const startLocale = firstSegment(start);
  if (
    locale !== undefined &&
    LOCALE_SEGMENT.test(locale) &&
    !ENGLISH_LOCALE.test(locale) &&
    locale.toLowerCase() !== startLocale?.toLowerCase()
  )
    return false;
  return true;
}

function isHtml(document: FetchedDocument): boolean {
  return document.contentType === "text/html" || document.contentType === "application/xhtml+xml";
}

function reasonOf(error: unknown): string {
  if (error instanceof FetchBlockedError) return `${error.code}: ${error.message}`.slice(0, 200);
  return (error instanceof Error ? error.message : "fetch failed").slice(0, 200);
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
          summary: `${document.status} ${document.contentType} ${document.bytes} bytes`,
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

  const report: CrawlReport = {
    collection,
    startUrl: start.href,
    pages: [],
    skipped: [],
    bytes: 0,
    sitemapUrls: 0,
    durationMs: 0,
  };
  const seen = new Set<string>();
  const hashes = new Set<string>();
  const queue: string[] = [];
  const enqueue = (raw: string) => {
    const url = canonicalUrl(raw);
    if (url === undefined || queue.length >= limits.maxQueue) return;
    const key = normaliseUrlKey(url);
    if (seen.has(key) || !crawlEligible(url, start, (candidate) => scope.contains(candidate)))
      return;
    seen.add(key);
    queue.push(url);
  };
  const skip = (url: string, reason: string) => {
    if (report.skipped.length < 200) report.skipped.push({ url, reason });
  };
  const outOfTime = () => ctx.now().getTime() - startedAt >= limits.maxDurationMs;

  enqueue(start.href);
  const sitemapQueue = [
    ...(await options.fetcher.sitemapsFor(start.origin).catch(() => [])),
    `${start.origin}/sitemap.xml`,
  ].filter((url) => scope.contains(url));
  const sitemapSeen = new Set<string>();
  const fromSitemaps: string[] = [];
  let sitemapFetches = 0;
  while (sitemapQueue.length > 0 && sitemapFetches < limits.maxSitemapFetches) {
    const next = sitemapQueue.shift();
    if (next === undefined || sitemapSeen.has(next)) continue;
    sitemapSeen.add(next);
    sitemapFetches += 1;
    try {
      const document = await fetchVia(next);
      report.bytes += document.bytes;
      const entries = parseSitemap(document.text);
      sitemapQueue.push(...entries.sitemaps.filter((url) => scope.contains(url)));
      fromSitemaps.push(...entries.urls);
    } catch (error) {
      skip(next, reasonOf(error));
    }
  }
  const sitemapUrls = [...new Set(fromSitemaps)]
    .filter((url) => crawlEligible(url, start, (candidate) => scope.contains(candidate)))
    .sort(
      (a, b) =>
        new URL(a).pathname.split("/").length - new URL(b).pathname.split("/").length ||
        a.length - b.length,
    )
    .slice(0, limits.maxSitemapUrls);
  report.sitemapUrls = sitemapUrls.length;
  for (const url of sitemapUrls) enqueue(url);

  const record = (page: StoredPage, cached: boolean, flaggedChunks: number) => {
    report.pages.push({
      url: page.url,
      title: page.title,
      documentId: page.documentId,
      chunks: page.chunkCount,
      flaggedChunks,
      cached,
    });
    for (const link of page.links) enqueue(link);
  };

  while (queue.length > 0 && report.pages.length < limits.maxPages) {
    if (ctx.signal?.aborted === true) break;
    if (report.bytes >= limits.maxBytes) {
      skip(queue[0] ?? "", "byte cap reached");
      break;
    }
    if (outOfTime()) {
      skip(queue[0] ?? "", "time cap reached");
      break;
    }
    const url = queue.shift();
    if (url === undefined) break;
    const cached = await knowledge.getPage(collection, url);
    if (cached !== null) {
      hashes.add(cached.contentHash);
      const flagged = (await knowledge.listChunks(collection)).filter(
        (chunk) => chunk.documentId === cached.documentId && chunk.flagged,
      ).length;
      record(cached, true, flagged);
      continue;
    }
    let document: FetchedDocument;
    try {
      document = await fetchVia(url);
    } catch (error) {
      skip(url, reasonOf(error));
      continue;
    }
    report.bytes += document.bytes;
    if (!isHtml(document)) {
      skip(url, `not HTML (${document.contentType})`);
      continue;
    }
    const finalUrl = canonicalUrl(document.finalUrl) ?? url;
    if (!scope.contains(finalUrl)) {
      skip(url, "redirected outside the site");
      continue;
    }
    seen.add(normaliseUrlKey(finalUrl));
    const html = htmlToText(document.text, finalUrl);
    const text = [html.description ?? "", html.text]
      .filter((part) => part.trim() !== "")
      .join("\n\n");
    if (text.length < limits.minTextChars) {
      skip(url, "too little text");
      continue;
    }
    const contentHash = createHash("sha256").update(text).digest("hex");
    if (hashes.has(contentHash)) {
      skip(url, "duplicate content");
      continue;
    }
    hashes.add(contentHash);
    const chunks = chunkPage(text).map((chunk) => ({
      ...chunk,
      flagged: detectInjection(chunk.text) !== undefined,
    }));
    const links = html.links
      .map((link) => link.href)
      .filter((href) => scope.contains(href))
      .slice(0, limits.maxLinksPerPage);
    const stored = await knowledge.putPage({
      collection,
      url,
      title: (html.title || finalUrl).slice(0, 300),
      contentHash,
      fetchedAt: document.fetchedAt,
      bytes: document.bytes,
      links,
      chunks,
    });
    record(stored, false, chunks.filter((chunk) => chunk.flagged).length);
  }
  report.durationMs = Math.max(0, ctx.now().getTime() - startedAt);
  return report;
}
