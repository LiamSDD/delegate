import { FetchBlockedError, type FetchedDocument, type Fetcher } from "../tools/fetch";
import { parseFeed, parseSitemapEntries } from "../tools/xml";
import {
  CRAWL_STATE_KIND,
  type CrawlCheckpoint,
  type CrawlPageRecord,
  type CrawlStateArtifact,
  type CrawlStats,
  type StopReason,
} from "./checkpoint";
import { DuplicateIndex, contentHash, fromHex, simhash } from "./dedupe";
import { extractPage, pageSourceText, type ExtractedPage } from "./extract";
import { Frontier, type FrontierEntry } from "./frontier";
import { HostPoliteness, realSleep, type HostStats } from "./politeness";
import { COMPANY_PROFILE, scoreUrl, type CrawlProfile, type UrlSource } from "./priority";
import { TrapGuard } from "./traps";
import { hostOf, nonContentReason, normaliseUrl, otherLocale, urlKey } from "./url";

export const CRAWL_DEFAULTS = {
  concurrency: 32,
  minConcurrency: 1,
  maxConcurrency: 64,
  maxPages: 60,
  maxBytes: 20 * 1024 * 1024,
  maxDurationMs: 25_000,
  maxDepth: 4,
  maxQueue: 2_000,
  maxSitemapFetches: 8,
  maxSitemapUrls: 5_000,
  sitemapParallelism: 3,
  maxFeeds: 2,
  maxLinksPerPage: 150,
  minTextChars: 40,
  nearDuplicateMinChars: 300,
  maxAttempts: 3,
  fetchesPerPage: 3,
  maxPerPattern: 25,
  maxSkippedRecorded: 300,
  progressEveryMs: 2_000,
  checkpointEveryPages: 50,
  checkpointFrontier: 400,
} as const;

export type CrawlBudget = Pick<
  { [K in keyof typeof CRAWL_DEFAULTS]: number },
  | "maxPages"
  | "maxBytes"
  | "maxDurationMs"
  | "maxDepth"
  | "maxQueue"
  | "maxSitemapFetches"
  | "maxSitemapUrls"
  | "maxFeeds"
  | "maxLinksPerPage"
  | "minTextChars"
  | "maxAttempts"
  | "maxPerPattern"
>;

export type CrawlRequestKind = "page" | "sitemap" | "feed";

export type CrawlFetch = (request: {
  url: string;
  kind: CrawlRequestKind;
  accept?: string;
  signal: AbortSignal;
}) => Promise<FetchedDocument>;

export interface CachedPage {
  title: string;
  links: readonly string[];
  contentHash: string;
}

export type CrawlPage =
  | {
      kind: "fetched";
      entry: FrontierEntry;
      finalUrl: string;
      document: FetchedDocument;
      page: ExtractedPage;
      text: string;
      contentHash: string;
    }
  | { kind: "cached"; entry: FrontierEntry; cached: CachedPage };

export interface CrawlSkip {
  url: string;
  code: string;
  reason: string;
}

export interface CrawlProgress {
  fetched: number;
  stored: number;
  queued: number;
  skipped: number;
  inFlight: number;
  bytes: number;
  elapsedMs: number;
  hosts: HostStats[];
  done: boolean;
}

export interface CrawlResult {
  pages: CrawlPageRecord[];
  skipped: CrawlSkip[];
  stats: CrawlStats;
  hosts: HostStats[];
  stopReason: StopReason;
  pending: FrontierEntry[];
  checkpoint: CrawlCheckpoint;
}

export interface CrawlOptions {
  fetcher: Fetcher;
  fetch?: CrawlFetch;
  seeds: readonly string[];
  scope: (url: string) => boolean;
  focusPath?: string;
  profile?: CrawlProfile;
  budget?: Partial<CrawlBudget>;
  concurrency?: number;
  politeness?: HostPoliteness;
  languages?: readonly string[] | "auto";
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  checkpoint?: CrawlCheckpoint;
  cached?: (url: string) => Promise<CachedPage | undefined>;
  onPage: (page: CrawlPage) => Promise<boolean>;
  onProgress?: (progress: CrawlProgress) => Promise<void> | void;
  progressEveryMs?: number;
  onCheckpoint?: (checkpoint: CrawlCheckpoint, progress: CrawlProgress) => Promise<void>;
  checkpointEveryPages?: number;
}

const FOCUS_BONUS = 300;
const OFF_FOCUS_PENALTY = 60;

export function underFocus(url: string, focusPath: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname.replace(/\/+$/, "");
  } catch {
    return false;
  }
  const prefix = focusPath.replace(/\/+$/, "");
  return path === prefix || path.startsWith(`${prefix}/`);
}

const SITEMAP_ACCEPT = "application/xml,text/xml;q=0.9,text/plain;q=0.5";
const FEED_ACCEPT = "application/rss+xml,application/atom+xml,application/xml;q=0.9,text/xml;q=0.8";
const PREFERRED_SITEMAP = /(page|main|post|doc|product|site|default|en)/i;

function cancellableTimer(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return {
    promise,
    cancel: () => {
      clearTimeout(timer);
    },
  };
}

function isHtml(document: FetchedDocument): boolean {
  return document.contentType === "text/html" || document.contentType === "application/xhtml+xml";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function clampConcurrency(value: number | undefined): number {
  return clamp(
    value ?? CRAWL_DEFAULTS.concurrency,
    CRAWL_DEFAULTS.minConcurrency,
    CRAWL_DEFAULTS.maxConcurrency,
  );
}

function emptyStats(): CrawlStats {
  return {
    fetched: 0,
    stored: 0,
    cached: 0,
    skipped: 0,
    retries: 0,
    bytes: 0,
    sitemapsFetched: 0,
    sitemapUrls: 0,
    feedsFetched: 0,
    skippedByCode: {},
    durationMs: 0,
  };
}

export function crawlStateArtifact(
  startUrl: string,
  checkpoint: CrawlCheckpoint,
  progress: CrawlProgress,
): CrawlStateArtifact {
  return {
    startUrl,
    finished: progress.done,
    progress: {
      fetched: progress.fetched,
      stored: progress.stored,
      queued: progress.queued,
      skipped: progress.skipped,
      inFlight: progress.inFlight,
      bytes: progress.bytes,
      elapsedMs: progress.elapsedMs,
      hosts: progress.hosts.map((host) => ({
        host: host.host,
        requestsPerSecond: host.requestsPerSecond,
        active: host.active,
        limit: host.limit,
        avgLatencyMs: host.avgLatencyMs,
        rateLimited: host.rateLimited,
        ...(host.crawlDelayMs === undefined ? {} : { crawlDelayMs: host.crawlDelayMs }),
      })),
    },
    checkpoint,
  };
}

export { CRAWL_STATE_KIND };

export function formatProgress(progress: CrawlProgress): string {
  const hosts = progress.hosts
    .filter((host) => host.requests > 0)
    .sort((a, b) => b.requests - a.requests)
    .slice(0, 3)
    .map(
      (host) =>
        `${host.host} ${host.requestsPerSecond} req/s (${host.active}/${host.limit} in flight${host.crawlDelayMs === undefined ? "" : `, crawl-delay ${host.crawlDelayMs / 1000}s`}${host.rateLimited > 0 ? `, ${host.rateLimited}× rate-limited` : ""})`,
    );
  return `${progress.done ? "Crawl finished" : "Crawling"}: ${progress.stored} pages kept, ${progress.fetched} fetched, ${progress.queued} queued, ${progress.skipped} skipped, ${Math.round(progress.bytes / 1024)} KB in ${(progress.elapsedMs / 1000).toFixed(1)} s${hosts.length === 0 ? "" : `; ${hosts.join("; ")}`}.`;
}

export async function crawl(options: CrawlOptions): Promise<CrawlResult> {
  const fetcherGate =
    options.fetcher.gate instanceof HostPoliteness ? options.fetcher.gate : undefined;
  const clockSource = fetcherGate ?? options.politeness;
  const now = options.now ?? clockSource?.now ?? (() => Date.now());
  const sleep = options.sleep ?? clockSource?.sleep ?? realSleep;
  const budget: CrawlBudget = {
    maxPages: CRAWL_DEFAULTS.maxPages,
    maxBytes: CRAWL_DEFAULTS.maxBytes,
    maxDurationMs: CRAWL_DEFAULTS.maxDurationMs,
    maxDepth: CRAWL_DEFAULTS.maxDepth,
    maxQueue: CRAWL_DEFAULTS.maxQueue,
    maxSitemapFetches: CRAWL_DEFAULTS.maxSitemapFetches,
    maxSitemapUrls: CRAWL_DEFAULTS.maxSitemapUrls,
    maxFeeds: CRAWL_DEFAULTS.maxFeeds,
    maxLinksPerPage: CRAWL_DEFAULTS.maxLinksPerPage,
    minTextChars: CRAWL_DEFAULTS.minTextChars,
    maxAttempts: CRAWL_DEFAULTS.maxAttempts,
    maxPerPattern: CRAWL_DEFAULTS.maxPerPattern,
    ...options.budget,
  };
  const profile = options.profile ?? COMPANY_PROFILE;
  const concurrency = clampConcurrency(options.concurrency);
  const gate =
    fetcherGate ?? options.politeness ?? new HostPoliteness({ now, sleep, minIntervalMs: 0 });
  const outerGate = options.fetcher.gate === undefined;
  const fetchDocument: CrawlFetch =
    options.fetch ??
    ((request) =>
      options.fetcher.fetch({
        url: request.url,
        signal: request.signal,
        ...(request.accept === undefined ? {} : { accept: request.accept }),
      }));
  const startedAt = now();
  const deadline = startedAt + budget.maxDurationMs;
  const controller = new AbortController();
  const signal =
    options.signal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, options.signal]);
  const focusPath = options.focusPath;
  const startUrl = new URL(normaliseUrl(options.seeds[0] ?? "") ?? options.seeds[0] ?? "");

  const frontier = new Frontier(budget.maxQueue);
  const traps = new TrapGuard({ maxPerPattern: budget.maxPerPattern });
  const duplicates = new DuplicateIndex();
  const done = new Set<string>();
  const pages: CrawlPageRecord[] = [];
  const skipped: CrawlSkip[] = [];
  const sitemapsSeen = new Set<string>();
  const feedsSeen = new Set<string>();
  let stats = emptyStats();
  let discovered = false;
  let sitemapFetchBase = 0;
  let sitemapUrlBase = 0;
  const sitemapFetches = () => stats.sitemapsFetched - sitemapFetchBase;
  let languages: Set<string> | undefined =
    options.languages === undefined || options.languages === "auto"
      ? undefined
      : new Set(options.languages);
  let stopReason: StopReason | undefined;
  let attempts = 0;
  let inFlightPages = 0;
  const inFlightByHost = new Map<string, number>();
  const running = new Set<Promise<void>>();
  const background = new Set<Promise<void>>();
  const inFlight = new Map<string, FrontierEntry>();

  const skip = (url: string, code: string, reason: string) => {
    stats.skipped += 1;
    stats.skippedByCode[code] = (stats.skippedByCode[code] ?? 0) + 1;
    if (skipped.length < CRAWL_DEFAULTS.maxSkippedRecorded)
      skipped.push({ url: url.slice(0, 500), code, reason: reason.slice(0, 200) });
  };

  const consider = (
    raw: string,
    context: {
      depth: number;
      source: UrlSource;
      anchorText?: string;
      lastmod?: string;
      inMainContent?: boolean;
      fromFocus?: boolean;
    },
  ): boolean => {
    const url = normaliseUrl(raw);
    if (url === undefined) return false;
    const key = urlKey(url);
    if (frontier.has(key) || done.has(key)) return false;
    const reject = (code: string, reason: string) => {
      frontier.markSeen(key);
      skip(url, code, reason);
      return false;
    };
    if (!options.scope(url)) return reject("scope", "outside the crawl scope");
    const focused =
      focusPath === undefined || underFocus(url, focusPath) || context.fromFocus === true;
    if (!focused && context.source === "sitemap")
      return reject("focus", "sitemap URL outside the crawl focus");
    const nonContent = nonContentReason(url);
    if (nonContent !== undefined) return reject("non_content", nonContent);
    if (otherLocale(new URL(url), startUrl)) return reject("non_content", "other locale");
    if (context.depth > budget.maxDepth) return reject("depth", `deeper than ${budget.maxDepth}`);
    const trap = traps.check(url);
    if (trap !== undefined) return reject("trap", trap);
    if (frontier.full()) {
      skip(url, "queue_full", `frontier holds ${budget.maxQueue} URLs`);
      return false;
    }
    const scored = scoreUrl(profile, {
      url,
      depth: context.depth,
      source: context.source,
      nowMs: now(),
      ...(context.anchorText === undefined ? {} : { anchorText: context.anchorText }),
      ...(context.lastmod === undefined ? {} : { lastmod: context.lastmod }),
      ...(context.inMainContent === undefined ? {} : { inMainContent: context.inMainContent }),
    });
    const focusAdjustment =
      focusPath === undefined ? 0 : focused ? FOCUS_BONUS : -OFF_FOCUS_PENALTY;
    return frontier.add({
      url,
      key,
      host: hostOf(url),
      depth: context.depth,
      score: scored.score + focusAdjustment,
      source: context.source,
      ...(scored.topic === undefined ? {} : { topic: scored.topic }),
      ...(context.lastmod === undefined ? {} : { lastmod: context.lastmod }),
      ...(focusPath === undefined ? {} : { focused }),
    });
  };

  const progress = (finished: boolean): CrawlProgress => ({
    fetched: stats.fetched,
    stored: stats.stored,
    queued: frontier.size,
    skipped: stats.skipped,
    inFlight: inFlightPages,
    bytes: stats.bytes,
    elapsedMs: Math.max(0, now() - startedAt),
    hosts: gate.stats(),
    done: finished,
  });

  const snapshot = (): CrawlCheckpoint => {
    const pendingEntries = [
      ...inFlight.values(),
      ...frontier.entries(CRAWL_DEFAULTS.checkpointFrontier),
    ];
    const truncated = inFlight.size + frontier.size > CRAWL_DEFAULTS.checkpointFrontier;
    return {
      version: 1,
      discovered: discovered && !truncated,
      ...(languages === undefined ? {} : { languages: [...languages] }),
      pages: [...pages],
      done: [...done],
      frontier: pendingEntries.slice(0, CRAWL_DEFAULTS.checkpointFrontier),
      duplicates: duplicates.entries(),
      patterns: traps.snapshot(),
      sitemaps: [...sitemapsSeen],
      stats: {
        ...stats,
        skippedByCode: { ...stats.skippedByCode },
        durationMs: Math.max(0, now() - startedAt),
      },
    };
  };

  let lastProgressAt = Number.NEGATIVE_INFINITY;
  let progressChain: Promise<void> = Promise.resolve();
  const reportProgress = (force: boolean) => {
    if (options.onProgress === undefined) return;
    const at = now();
    if (!force && at - lastProgressAt < (options.progressEveryMs ?? CRAWL_DEFAULTS.progressEveryMs))
      return;
    lastProgressAt = at;
    const current = progress(false);
    const report = options.onProgress;
    progressChain = progressChain.then(() => report(current)).catch(() => undefined);
  };

  let lastCheckpointPages = 0;
  let checkpointChain: Promise<void> = Promise.resolve();
  const maybeCheckpoint = () => {
    if (options.onCheckpoint === undefined) return;
    const every = options.checkpointEveryPages ?? CRAWL_DEFAULTS.checkpointEveryPages;
    if (stats.stored - lastCheckpointPages < every) return;
    lastCheckpointPages = stats.stored;
    const state = snapshot();
    const current = progress(false);
    const save = options.onCheckpoint;
    checkpointChain = checkpointChain.then(() => save(state, current)).catch(() => undefined);
  };

  if (options.checkpoint !== undefined) {
    const restored = options.checkpoint;
    stats = { ...restored.stats, skippedByCode: { ...restored.stats.skippedByCode } };
    stats.durationMs = 0;
    discovered = restored.discovered;
    if (restored.languages !== undefined) languages = new Set(restored.languages);
    for (const key of restored.done) {
      done.add(key);
      frontier.markSeen(key);
    }
    pages.push(...restored.pages);
    for (const entry of restored.duplicates)
      duplicates.add(
        entry.hash,
        entry.simhash === "" ? undefined : fromHex(entry.simhash),
        entry.url,
      );
    traps.restore(restored.patterns);
    if (restored.discovered) for (const sitemap of restored.sitemaps) sitemapsSeen.add(sitemap);
    else {
      sitemapFetchBase = stats.sitemapsFetched;
      sitemapUrlBase = stats.sitemapUrls;
    }
    for (const entry of restored.frontier) {
      if (done.has(entry.key) || frontier.has(entry.key)) continue;
      frontier.add({
        url: entry.url,
        key: entry.key,
        host: entry.host,
        depth: entry.depth,
        score: entry.score,
        source: entry.source,
        attempts: entry.attempts,
        ...(entry.topic === undefined ? {} : { topic: entry.topic }),
        ...(entry.lastmod === undefined ? {} : { lastmod: entry.lastmod }),
        ...(entry.focused === undefined ? {} : { focused: entry.focused }),
      });
    }
    lastCheckpointPages = stats.stored;
  } else {
    for (const seed of options.seeds) {
      const url = normaliseUrl(seed);
      if (url === undefined || !options.scope(url)) continue;
      frontier.add({
        url,
        key: urlKey(url),
        host: hostOf(url),
        depth: 0,
        score: 10_000,
        source: "seed",
        ...(focusPath === undefined ? {} : { focused: true }),
      });
    }
  }

  const track = (set: Set<Promise<void>>, task: Promise<void>) => {
    const safe = task.catch(() => undefined);
    set.add(safe);
    void safe.finally(() => set.delete(safe));
  };

  const sitemapQueue: { url: string; lastmod?: string }[] = [];
  let sitemapActive = 0;
  const pumpSitemaps = () => {
    sitemapQueue.sort(
      (a, b) =>
        (b.lastmod ?? "").localeCompare(a.lastmod ?? "") ||
        Number(PREFERRED_SITEMAP.test(b.url)) - Number(PREFERRED_SITEMAP.test(a.url)),
    );
    while (
      sitemapActive < CRAWL_DEFAULTS.sitemapParallelism &&
      sitemapFetches() < budget.maxSitemapFetches &&
      sitemapQueue.length > 0 &&
      !signal.aborted
    ) {
      const next = sitemapQueue.shift();
      if (next === undefined) break;
      sitemapActive += 1;
      stats.sitemapsFetched += 1;
      track(
        background,
        fetchSitemap(next.url).finally(() => {
          sitemapActive -= 1;
          pumpSitemaps();
        }),
      );
    }
  };
  const queueSitemap = (raw: string, lastmod?: string) => {
    const url = normaliseUrl(raw);
    if (url === undefined || sitemapsSeen.has(url)) return;
    sitemapsSeen.add(url);
    if (!options.scope(url)) {
      skip(url, "scope", "sitemap outside the crawl scope");
      return;
    }
    if (sitemapFetches() + sitemapQueue.length >= budget.maxSitemapFetches) {
      skip(url, "sitemap_cap", `more than ${budget.maxSitemapFetches} sitemaps`);
      return;
    }
    sitemapQueue.push({ url, ...(lastmod === undefined ? {} : { lastmod }) });
  };

  async function fetchSitemap(url: string): Promise<void> {
    let document: FetchedDocument;
    try {
      document = await fetchDocument({ url, kind: "sitemap", accept: SITEMAP_ACCEPT, signal });
    } catch (error) {
      skip(
        url,
        error instanceof FetchBlockedError ? `fetch:${error.code}` : "error",
        errorText(error),
      );
      return;
    }
    stats.bytes += document.bytes;
    const final = normaliseUrl(document.finalUrl);
    if (final === undefined || !options.scope(final)) {
      skip(url, "redirected_out", "sitemap redirected outside the crawl scope");
      return;
    }
    if (document.truncated === true)
      skip(url, "truncated", `sitemap cut at ${document.bytes} bytes`);
    const room = Math.max(0, budget.maxSitemapUrls - (stats.sitemapUrls - sitemapUrlBase));
    const entries = parseSitemapEntries(document.text, room + 1);
    for (const child of entries.sitemaps) queueSitemap(child.loc, child.lastmod);
    let taken = 0;
    for (const entry of entries.urls) {
      if (taken >= room) {
        skip(url, "sitemap_cap", `sitemap URLs capped at ${budget.maxSitemapUrls}`);
        break;
      }
      taken += 1;
      consider(entry.loc, {
        depth: 1,
        source: "sitemap",
        ...(entry.lastmod === undefined ? {} : { lastmod: entry.lastmod }),
      });
    }
    stats.sitemapUrls += taken;
  }

  async function fetchFeed(url: string, depth: number): Promise<void> {
    stats.feedsFetched += 1;
    let document: FetchedDocument;
    try {
      document = await fetchDocument({ url, kind: "feed", accept: FEED_ACCEPT, signal });
    } catch (error) {
      skip(
        url,
        error instanceof FetchBlockedError ? `fetch:${error.code}` : "error",
        errorText(error),
      );
      return;
    }
    stats.bytes += document.bytes;
    const final = normaliseUrl(document.finalUrl);
    if (final === undefined || !options.scope(final)) {
      skip(url, "redirected_out", "feed redirected outside the crawl scope");
      return;
    }
    for (const item of parseFeed(document.text, 20)) {
      if (item.link === undefined) continue;
      consider(new URL(item.link, final).href, {
        depth: depth + 1,
        source: "feed",
        ...(item.published === undefined ? {} : { lastmod: item.published }),
      });
    }
  }

  const discover = async () => {
    const origins = [
      ...new Set(
        options.seeds
          .map((seed) => {
            try {
              return new URL(seed).origin;
            } catch {
              return "";
            }
          })
          .filter((origin) => origin !== ""),
      ),
    ];
    for (const origin of origins) {
      const declared = await options.fetcher.sitemapsFor(origin).catch(() => []);
      for (const sitemap of declared) queueSitemap(sitemap);
      queueSitemap(`${origin}/sitemap.xml`);
      if (declared.length === 0) queueSitemap(`${origin}/sitemap_index.xml`);
    }
    discovered = true;
    pumpSitemaps();
  };

  const enqueueLinks = (entry: FrontierEntry, page: ExtractedPage, finalUrl: string) => {
    if (page.robots.nofollow) return;
    const ordered = [
      ...page.links.filter((link) => page.mainLinks.has(link.href)),
      ...page.links.filter((link) => !page.mainLinks.has(link.href)),
    ];
    const linksFromFocus =
      focusPath !== undefined && (entry.depth === 0 || underFocus(finalUrl, focusPath));
    let considered = 0;
    for (const link of ordered) {
      if (considered >= budget.maxLinksPerPage) {
        skip(
          finalUrl,
          "link_cap",
          `${ordered.length - considered} more links ignored (cap ${budget.maxLinksPerPage} per page)`,
        );
        break;
      }
      considered += 1;
      consider(link.href, {
        depth: entry.depth + 1,
        source: "link",
        anchorText: link.text,
        inMainContent: page.mainLinks.has(link.href),
        fromFocus: linksFromFocus,
      });
    }
    if (!discovered) return;
    for (const hint of page.sitemapHints) queueSitemap(hint);
    pumpSitemaps();
    if (profile.topics.some((topic) => topic.name === "news")) {
      for (const feed of page.feeds) {
        const url = normaliseUrl(feed.href);
        if (url === undefined || feedsSeen.has(url) || feedsSeen.size >= budget.maxFeeds) continue;
        feedsSeen.add(url);
        if (!options.scope(url)) {
          skip(url, "scope", "feed outside the crawl scope");
          continue;
        }
        track(background, fetchFeed(url, entry.depth));
      }
    }
  };

  const record = (
    entry: FrontierEntry,
    values: {
      finalUrl: string;
      title: string;
      bytes: number;
      cached: boolean;
      language: string;
      extraction: string;
    },
  ) => {
    stats.stored += 1;
    pages.push({
      url: entry.url,
      finalUrl: values.finalUrl,
      key: entry.key,
      title: values.title.slice(0, 300),
      depth: entry.depth,
      score: entry.score,
      ...(entry.topic === undefined ? {} : { topic: entry.topic }),
      source: entry.source,
      bytes: values.bytes,
      cached: values.cached,
      language: values.language,
      extraction: values.extraction,
    });
    maybeCheckpoint();
  };

  const handleFailure = (entry: FrontierEntry, error: unknown) => {
    if (error instanceof FetchBlockedError) {
      if (error.code === "page_cap") {
        stopReason ??= "page_cap";
        frontier.requeue(entry);
        return;
      }
      if (error.code === "aborted" || signal.aborted) {
        frontier.requeue(entry);
        return;
      }
      const retryable =
        (error.code === "http_error" && (error.status === 429 || error.status === 503)) ||
        error.code === "timeout" ||
        error.code === "network";
      if (retryable && entry.attempts + 1 < budget.maxAttempts) {
        const wait = Math.max(gate.readyIn(entry.host), error.retryAfterMs ?? 0);
        if (now() + wait < deadline) {
          stats.retries += 1;
          frontier.requeue({ ...entry, attempts: entry.attempts + 1 });
          return;
        }
      }
      done.add(entry.key);
      const code =
        error.code === "http_error" && (error.status === 429 || error.status === 503)
          ? "rate_limited"
          : error.code === "robots"
            ? "robots"
            : `fetch:${error.code}`;
      skip(entry.url, code, error.message);
      return;
    }
    done.add(entry.key);
    skip(entry.url, "error", errorText(error));
  };

  const process = async (entry: FrontierEntry): Promise<void> => {
    const cached = await options.cached?.(entry.url).catch(() => undefined);
    if (cached !== undefined) {
      done.add(entry.key);
      stats.cached += 1;
      duplicates.add(cached.contentHash, undefined, entry.url);
      const accepted = await options.onPage({ kind: "cached", entry, cached });
      if (!accepted) return;
      record(entry, {
        finalUrl: entry.url,
        title: cached.title,
        bytes: 0,
        cached: true,
        language: "und",
        extraction: "cached",
      });
      for (const link of cached.links.slice(0, budget.maxLinksPerPage))
        consider(link, { depth: entry.depth + 1, source: "link" });
      return;
    }
    attempts += 1;
    let document: FetchedDocument;
    const release = outerGate
      ? await gate.acquire(entry.host, signal).catch(() => undefined)
      : undefined;
    const fetchStarted = now();
    try {
      if (outerGate && release === undefined)
        throw new FetchBlockedError("aborted", entry.url, "The crawl stopped");
      document = await fetchDocument({ url: entry.url, kind: "page", signal });
      release?.({ latencyMs: now() - fetchStarted, status: document.status });
    } catch (error) {
      release?.({
        latencyMs: now() - fetchStarted,
        failed: true,
        ...(error instanceof FetchBlockedError && error.status !== undefined
          ? { status: error.status }
          : {}),
        ...(error instanceof FetchBlockedError && error.retryAfterMs !== undefined
          ? { retryAfterMs: error.retryAfterMs }
          : {}),
      });
      handleFailure(entry, error);
      return;
    }
    done.add(entry.key);
    stats.fetched += 1;
    stats.bytes += document.bytes;
    const finalUrl = normaliseUrl(document.finalUrl) ?? entry.url;
    if (!options.scope(finalUrl)) {
      skip(
        entry.url,
        "redirected_out",
        `redirected outside the crawl scope to ${hostOf(finalUrl)}`,
      );
      return;
    }
    const finalKey = urlKey(finalUrl);
    if (finalKey !== entry.key) {
      if (done.has(finalKey)) {
        skip(entry.url, "duplicate", `redirects to ${finalUrl}, already crawled`);
        return;
      }
      done.add(finalKey);
      frontier.markSeen(finalKey);
    }
    if (!isHtml(document)) {
      skip(entry.url, "not_html", `content type ${document.contentType}`);
      return;
    }
    const page = extractPage(document.text, finalUrl);
    enqueueLinks(entry, page, finalUrl);
    const canonical = page.canonical === undefined ? undefined : normaliseUrl(page.canonical);
    if (canonical !== undefined && options.scope(canonical)) {
      const canonicalKey = urlKey(canonical);
      if (canonicalKey !== finalKey) {
        if (done.has(canonicalKey) && pages.some((stored) => stored.key === canonicalKey)) {
          skip(entry.url, "duplicate", `canonical ${canonical} already crawled`);
          return;
        }
        done.add(canonicalKey);
        frontier.markSeen(canonicalKey);
      }
    }
    if (page.robots.noindex) {
      skip(entry.url, "noindex", "the page asks not to be indexed");
      return;
    }
    if (languages === undefined && page.language !== "und")
      languages = new Set([page.language, "en"]);
    if (languages !== undefined && page.language !== "und" && !languages.has(page.language)) {
      skip(entry.url, "language", `page language ${page.language}`);
      return;
    }
    const text = pageSourceText(page);
    if (entry.depth > 0 && text.trim().length < budget.minTextChars) {
      skip(entry.url, "thin", "too little main content");
      return;
    }
    const hash = contentHash(page.mainText);
    const sim = simhash(page.mainText);
    const nearCheck = page.mainText.length >= CRAWL_DEFAULTS.nearDuplicateMinChars;
    const duplicate = duplicates.find(hash, nearCheck ? sim : undefined);
    if (duplicate !== undefined) {
      skip(
        entry.url,
        duplicate.kind === "exact" ? "duplicate" : "near_duplicate",
        `same content as ${duplicate.url}`,
      );
      return;
    }
    if (stats.stored >= budget.maxPages) {
      frontier.requeue(entry);
      return;
    }
    duplicates.add(hash, nearCheck ? sim : undefined, entry.url);
    const accepted = await options.onPage({
      kind: "fetched",
      entry,
      finalUrl,
      document,
      page,
      text,
      contentHash: hash,
    });
    if (!accepted) {
      skip(entry.url, "rejected", "not stored");
      return;
    }
    record(entry, {
      finalUrl,
      title: page.title || finalUrl,
      bytes: document.bytes,
      cached: false,
      language: page.language,
      extraction: page.extraction,
    });
  };

  const dispatch = (entry: FrontierEntry) => {
    inFlightPages += 1;
    inFlightByHost.set(entry.host, (inFlightByHost.get(entry.host) ?? 0) + 1);
    inFlight.set(entry.key, entry);
    const task = process(entry)
      .catch((error: unknown) => {
        skip(entry.url, "error", errorText(error));
      })
      .finally(() => {
        inFlightPages -= 1;
        inFlightByHost.set(entry.host, (inFlightByHost.get(entry.host) ?? 1) - 1);
        inFlight.delete(entry.key);
        reportProgress(false);
      });
    track(running, task);
  };

  const eligible = (host: string) => {
    const active = inFlightByHost.get(host) ?? 0;
    if (active >= gate.limit(host) || gate.backoffIn(host) > 0) return false;
    return active === 0 || gate.readyIn(host) <= 0;
  };

  const nextReadyIn = (): number => {
    let best = Number.POSITIVE_INFINITY;
    for (const host of frontier.hosts()) {
      if ((inFlightByHost.get(host) ?? 0) >= gate.limit(host)) continue;
      best = Math.min(best, gate.readyIn(host));
    }
    return best;
  };

  if (!discovered) track(background, discover());
  const deadlineState = { pending: sleep === realSleep };
  const deadlineWait = deadlineState.pending
    ? cancellableTimer(Math.max(0, deadline - now()))
    : { promise: new Promise<void>(() => undefined), cancel: () => undefined };
  const deadlineTimer = deadlineWait.promise.then(() => {
    deadlineState.pending = false;
  });
  let idleSpins = 0;
  reportProgress(true);

  for (;;) {
    if (options.signal?.aborted === true) stopReason ??= "aborted";
    if (now() >= deadline) stopReason ??= "time_budget";
    if (stats.stored >= budget.maxPages) stopReason ??= "page_budget";
    if (stats.bytes >= budget.maxBytes) stopReason ??= "byte_budget";
    if (attempts >= budget.maxPages * CRAWL_DEFAULTS.fetchesPerPage) stopReason ??= "fetch_budget";
    if (stopReason !== undefined) break;
    while (
      running.size < concurrency &&
      stats.stored + inFlightPages < budget.maxPages &&
      attempts + inFlightPages < budget.maxPages * CRAWL_DEFAULTS.fetchesPerPage
    ) {
      const entry = frontier.popBest(eligible);
      if (entry === undefined) break;
      dispatch(entry);
    }
    const wait = nextReadyIn();
    if (running.size === 0 && background.size === 0) {
      if (frontier.size === 0) {
        stopReason = "exhausted";
        break;
      }
      if (!Number.isFinite(wait) || now() + wait >= deadline) {
        stopReason = Number.isFinite(wait) ? "time_budget" : "exhausted";
        break;
      }
      const before = now();
      await sleep(Math.max(1, wait));
      idleSpins = now() === before ? idleSpins + 1 : 0;
      if (idleSpins > 100) {
        stopReason = "time_budget";
        break;
      }
      continue;
    }
    const wakers: Promise<unknown>[] = [
      ...running,
      ...background,
      ...(deadlineState.pending ? [deadlineTimer] : []),
    ];
    if (Number.isFinite(wait) && running.size < concurrency)
      wakers.push(sleep(Math.max(1, Math.min(wait, deadline - now()))));
    await Promise.race(wakers);
  }

  if (stopReason === "time_budget" || stopReason === "aborted" || stopReason === "page_cap")
    controller.abort();
  await Promise.allSettled([...running]);
  controller.abort();
  deadlineWait.cancel();
  await Promise.allSettled([...background]);
  await checkpointChain;
  stats.durationMs = Math.max(0, now() - startedAt);
  const checkpoint = snapshot();
  const final = { ...progress(true) };
  if (options.onProgress !== undefined) {
    const report = options.onProgress;
    progressChain = progressChain.then(() => report(final)).catch(() => undefined);
  }
  await progressChain;
  if (options.onCheckpoint !== undefined)
    await options.onCheckpoint(checkpoint, final).catch(() => undefined);
  return {
    pages,
    skipped,
    stats: checkpoint.stats,
    hosts: gate.stats(),
    stopReason: stopReason,
    pending: frontier.entries(50),
    checkpoint,
  };
}

function errorText(error: unknown): string {
  if (error instanceof FetchBlockedError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : "failed";
}
