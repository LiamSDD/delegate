import { CAPABILITIES } from "@delegate/policy";
import { z } from "zod";

import { FetchBlockedError, type FetchedDocument, type Fetcher } from "./fetch";
import { htmlToText, type HtmlDocument } from "./html";
import { defineTool, type RegisteredTool, type ToolExecution, type ToolOutcome } from "./registry";
import { SourceStore, snapshotContent, type SourceDocument, type SourceKind } from "./sources";
import { parseFeed, parseSitemap } from "./xml";

export const RESEARCH_LIMITS = {
  defaultCrawlPages: 8,
  maxCrawlPages: 15,
  maxSitemapFetches: 2,
  maxNameLookups: 2,
  maxFeedItems: 10,
  maxUnfetchedHints: 20,
} as const;

export interface SiteScope {
  origin: string;
  root: string;
  contains(url: string): boolean;
}

export interface Discoveries {
  names: string[];
  githubOrgs: string[];
  feeds: string[];
  unfetched: string[];
}

export interface ResearchEnvironment {
  fetcher: Fetcher;
  sources: SourceStore;
  scope: SiteScope;
  siteUrl: string;
  discoveries: Discoveries;
  digest: (documents: SourceDocument[], execution: ToolExecution) => Promise<string>;
  signal?: AbortSignal;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function siteScope(url: string): SiteScope {
  const parsed = new URL(url);
  const roots = [parsed.hostname.toLowerCase().replace(/^www\./, "")];
  return {
    origin: parsed.origin,
    root: roots[0] ?? parsed.hostname,
    contains(candidate) {
      const host = hostOf(candidate);
      if (host === undefined) return false;
      return roots.some((root) => host === root || host.endsWith(`.${root}`));
    },
  };
}

export function createResearchEnvironment(options: {
  fetcher: Fetcher;
  siteUrl: string;
  digest: ResearchEnvironment["digest"];
  signal?: AbortSignal;
}): ResearchEnvironment {
  return {
    fetcher: options.fetcher,
    sources: new SourceStore(),
    scope: siteScope(options.siteUrl),
    siteUrl: options.siteUrl,
    discoveries: { names: [], githubOrgs: [], feeds: [], unfetched: [] },
    digest: options.digest,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

const CATEGORIES: readonly { name: string; keywords: readonly string[] }[] = [
  {
    name: "about",
    keywords: [
      "about",
      "about-us",
      "company",
      "who-we-are",
      "our-story",
      "team",
      "leadership",
      "mission",
    ],
  },
  { name: "pricing", keywords: ["pricing", "plans", "price"] },
  {
    name: "customers",
    keywords: [
      "customers",
      "customer",
      "case-studies",
      "case-study",
      "success-stories",
      "testimonials",
      "clients",
    ],
  },
  {
    name: "product",
    keywords: [
      "product",
      "products",
      "platform",
      "features",
      "solutions",
      "services",
      "how-it-works",
    ],
  },
  { name: "comparisons", keywords: ["vs", "compare", "comparison", "alternatives", "alternative"] },
  {
    name: "news",
    keywords: ["news", "blog", "press", "newsroom", "media", "updates", "changelog"],
  },
  { name: "careers", keywords: ["careers", "jobs", "join-us", "hiring", "work-with-us"] },
];
const EXCLUDED_SEGMENTS =
  /^(legal|imprint|impressum|privacy|terms|cookies?|login|signin|sign-in|signup|sign-up|register|cart|checkout|account|search|tag|tags|author|wp-admin|wp-content|cdn-cgi)$/;
const ASSET_EXTENSION =
  /\.(png|jpe?g|gif|svg|webp|ico|pdf|zip|gz|mp4|mp3|css|js|json|xml|txt|woff2?)$/i;
const LOCALE_SEGMENT = /^[a-z]{2}([-_][a-z]{2})?$/i;
const MAX_CATEGORY_DEPTH = 2;

interface RankedCandidate {
  url: string;
  category: number;
  score: number;
}

function rankCandidate(url: string): RankedCandidate | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (ASSET_EXTENSION.test(parsed.pathname)) return undefined;
  const segments = parsed.pathname
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => segment.toLowerCase());
  if (segments.some((segment) => EXCLUDED_SEGMENTS.test(segment))) return undefined;
  const localised =
    segments[0] !== undefined && LOCALE_SEGMENT.test(segments[0]) && segments[0] !== "vs";
  const content = localised ? segments.slice(1) : segments;
  const category =
    content.length > MAX_CATEGORY_DEPTH
      ? -1
      : CATEGORIES.findIndex((candidate) =>
          content.some((segment) =>
            candidate.keywords.some(
              (keyword) => segment === keyword || segment.startsWith(`${keyword}-`),
            ),
          ),
        );
  const score = 100 - content.length * 5 - (localised ? 30 : 0) - (parsed.search === "" ? 0 : 10);
  return { url: parsed.href, category, score };
}

export function rankCandidates(urls: readonly string[], limit: number): string[] {
  const ranked = [...new Set(urls)]
    .map(rankCandidate)
    .filter((candidate): candidate is RankedCandidate => candidate !== undefined)
    .sort((a, b) => b.score - a.score);
  const picked: string[] = [];
  for (let category = 0; category < CATEGORIES.length && picked.length < limit; category += 1) {
    const best = ranked.find((candidate) => candidate.category === category);
    if (best !== undefined) picked.push(best.url);
  }
  const rest = ranked.filter((candidate) => !picked.includes(candidate.url));
  const fill = [
    ...rest.filter((candidate) => candidate.category !== -1),
    ...rest.filter((candidate) => candidate.category === -1 && candidate.score >= 95),
  ];
  for (const candidate of fill) {
    if (picked.length >= limit) break;
    picked.push(candidate.url);
  }
  return picked;
}

function fetchError(error: unknown): Error {
  if (error instanceof FetchBlockedError) return new Error(`${error.code}: ${error.message}`);
  return error instanceof Error ? error : new Error("Fetch failed");
}

async function fetchDocument(
  env: ResearchEnvironment,
  url: string,
  options: { api?: boolean; accept?: string } = {},
): Promise<FetchedDocument> {
  try {
    return await env.fetcher.fetch({
      url,
      ...(options.api === true ? { respectRobots: false } : {}),
      ...(options.accept === undefined ? {} : { accept: options.accept }),
      ...(env.signal === undefined ? {} : { signal: env.signal }),
    });
  } catch (error) {
    throw fetchError(error);
  }
}

function isHtml(document: FetchedDocument): boolean {
  return document.contentType === "text/html" || document.contentType === "application/xhtml+xml";
}

function pageText(page: HtmlDocument): string {
  return [page.description === undefined ? "" : `Description: ${page.description}`, page.text]
    .filter((part) => part !== "")
    .join("\n\n");
}

function storePage(
  env: ResearchEnvironment,
  document: FetchedDocument,
  kind: SourceKind,
): { source: SourceDocument; created: boolean; page?: HtmlDocument } {
  if (!isHtml(document)) {
    const { document: source, created } = env.sources.add({
      url: document.finalUrl,
      title: document.finalUrl,
      kind,
      fetchedAt: document.fetchedAt,
      text: document.text,
    });
    return { source, created };
  }
  const page = htmlToText(document.text, document.finalUrl);
  const { document: source, created } = env.sources.add({
    url: document.finalUrl,
    title: page.title,
    kind,
    fetchedAt: document.fetchedAt,
    text: pageText(page),
    hiddenText: page.hiddenText,
  });
  return { source, created, page };
}

const GITHUB_RESERVED = new Set([
  "features",
  "about",
  "pricing",
  "login",
  "sponsors",
  "topics",
  "orgs",
  "enterprise",
  "marketplace",
  "explore",
  "settings",
  "apps",
  "collections",
  "events",
  "site",
  "security",
  "customer-stories",
  "readme",
]);

function recordDiscoveries(env: ResearchEnvironment, page: HtmlDocument): void {
  const names = new Set(env.discoveries.names);
  if (page.siteName !== undefined) names.add(page.siteName);
  for (const segment of page.title.split(/\s+[|–—:·-]\s+/)) {
    const trimmed = segment.trim();
    if (trimmed.length >= 2 && trimmed.length <= 40) names.add(trimmed);
  }
  const label = env.scope.root.split(".")[0] ?? "";
  if (label.length >= 2) names.add(label.charAt(0).toUpperCase() + label.slice(1));
  env.discoveries.names = [...names].slice(0, 5);

  const orgs = new Set(env.discoveries.githubOrgs);
  for (const link of page.links) {
    const match =
      /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/?(?:$|[?#]|[A-Za-z0-9._-]+\/?$)/.exec(
        link.href,
      );
    const org = match?.[1]?.toLowerCase();
    if (org !== undefined && !GITHUB_RESERVED.has(org)) orgs.add(org);
  }
  const domainLabel = label.toLowerCase();
  env.discoveries.githubOrgs = [...orgs]
    .sort((a, b) => Number(b === domainLabel) - Number(a === domainLabel))
    .slice(0, 3);

  const feeds = new Set(env.discoveries.feeds);
  for (const feed of page.feeds) if (env.scope.contains(feed.href)) feeds.add(feed.href);
  env.discoveries.feeds = [...feeds].slice(0, 3);
}

async function outcomeFor(
  env: ResearchEnvironment,
  documents: SourceDocument[],
  execution: ToolExecution,
  summary: string,
  title: string,
): Promise<ToolOutcome> {
  return {
    summary,
    forModel:
      documents.length === 0
        ? `${summary}. No new sources.`
        : await env.digest(documents, execution),
    ...(documents.length === 0
      ? {}
      : { artifact: { kind: "source-snapshot", title, content: snapshotContent(documents) } }),
  };
}

async function sitemapCandidates(
  env: ResearchEnvironment,
  hints: readonly string[],
): Promise<string[]> {
  const fromRobots = await env.fetcher.sitemapsFor(env.siteUrl).catch(() => []);
  const queue = [...new Set([...fromRobots, ...hints, `${env.scope.origin}/sitemap.xml`])].filter(
    (url) => env.scope.contains(url),
  );
  const urls: string[] = [];
  for (
    let fetches = 0;
    fetches < RESEARCH_LIMITS.maxSitemapFetches && queue.length > 0;
    fetches += 1
  ) {
    const next = queue.shift();
    if (next === undefined) break;
    try {
      const document = await fetchDocument(env, next, { accept: "application/xml,text/xml" });
      const entries = parseSitemap(document.text);
      urls.push(...entries.urls);
      const children = entries.sitemaps.filter((url) => env.scope.contains(url));
      const preferred =
        children.find((url) => /page|main|site|default|en/i.test(new URL(url).pathname)) ??
        children[0];
      if (preferred !== undefined) queue.unshift(preferred);
      if (entries.urls.length > 0) break;
    } catch {
      continue;
    }
  }
  return urls;
}

function crawlSite(env: ResearchEnvironment): RegisteredTool {
  return defineTool({
    name: "crawl_site",
    description:
      "Crawl the company's own website politely (robots.txt honoured, same site only): homepage, sitemap and the most informative pages such as about, pricing, customers, product, comparisons, news and careers. Returns quarantined facts, never raw page text.",
    capability: CAPABILITIES.webFetch,
    inputSchema: z.object({
      maxPages: z.number().int().min(1).max(RESEARCH_LIMITS.maxCrawlPages).optional(),
    }),
    targetDomain: () => hostOf(env.siteUrl),
    summariseArgs: (input) =>
      `crawl ${env.scope.root} (up to ${input.maxPages ?? RESEARCH_LIMITS.defaultCrawlPages} pages)`,
    execute: async (input, execution) => {
      const maxPages = input.maxPages ?? RESEARCH_LIMITS.defaultCrawlPages;
      const created: SourceDocument[] = [];
      const skipped: string[] = [];
      let links: string[] = [];
      let hints: string[] = [];
      if (!env.sources.has(env.siteUrl)) {
        const home = storePage(env, await fetchDocument(env, env.siteUrl), "company_site");
        if (home.created) created.push(home.source);
        if (home.page !== undefined) {
          recordDiscoveries(env, home.page);
          links = home.page.links.map((link) => link.href);
          hints = home.page.sitemapHints;
        }
      }
      const fromSitemap = await sitemapCandidates(env, hints);
      const candidates = [...links, ...fromSitemap].filter(
        (url) => env.scope.contains(url) && !env.sources.has(url),
      );
      const picked = rankCandidates(candidates, Math.max(0, maxPages - 1));
      env.discoveries.unfetched = rankCandidates(
        candidates.filter((url) => !picked.includes(url)),
        RESEARCH_LIMITS.maxUnfetchedHints,
      );
      const results = await Promise.allSettled(picked.map((url) => fetchDocument(env, url)));
      for (const [index, result] of results.entries()) {
        if (result.status === "rejected") {
          skipped.push(
            `${picked[index] ?? ""}: ${result.reason instanceof Error ? result.reason.message : "failed"}`,
          );
          continue;
        }
        const stored = storePage(env, result.value, "company_site");
        if (stored.created) created.push(stored.source);
      }
      const summary = `Fetched ${created.length} page${created.length === 1 ? "" : "s"} from ${env.scope.root}${skipped.length === 0 ? "" : ` (${skipped.length} skipped)`}`;
      return outcomeFor(env, created, execution, summary, `Raw pages from ${env.scope.root}`);
    },
  });
}

function inFetchScope(env: ResearchEnvironment, url: string): SourceKind | undefined {
  const host = hostOf(url);
  if (host === undefined) return undefined;
  if (env.scope.contains(url)) return "company_site";
  if (host === "en.wikipedia.org" && new URL(url).pathname.startsWith("/wiki/")) return "wikipedia";
  if (host === "github.com") return "github";
  return undefined;
}

function fetchPage(env: ResearchEnvironment): RegisteredTool {
  return defineTool({
    name: "fetch_page",
    description:
      "Fetch one page from the company's own site, an English Wikipedia article or a GitHub page. Use it to fill a specific evidence gap. Returns quarantined facts, never raw page text.",
    capability: CAPABILITIES.webFetch,
    inputSchema: z.object({ url: z.string().min(1).max(2048) }),
    targetDomain: (input) => hostOf(input.url),
    summariseArgs: (input) => `GET ${input.url}`,
    execute: async (input, execution) => {
      const kind = inFetchScope(env, input.url);
      if (kind === undefined) {
        throw new Error(
          `URL is outside the research scope (${env.scope.root}, en.wikipedia.org/wiki, github.com)`,
        );
      }
      if (env.sources.has(input.url)) {
        return {
          summary: `Already fetched ${input.url}`,
          forModel: `${input.url} was already fetched; its facts are in your input.`,
        };
      }
      const stored = storePage(env, await fetchDocument(env, input.url), kind);
      if (stored.page !== undefined && kind === "company_site") recordDiscoveries(env, stored.page);
      const documents = stored.created ? [stored.source] : [];
      return outcomeFor(
        env,
        documents,
        execution,
        `Fetched ${stored.source.record.url}`,
        `Raw page ${stored.source.record.url}`,
      );
    },
  });
}

const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const JSON_ACCEPT = "application/json";

const SnakValueSchema = z.object({
  mainsnak: z.object({ datavalue: z.object({ value: z.unknown() }).optional() }),
});
const WikidataEntitySchema = z.object({
  id: z.string(),
  labels: z.record(z.string(), z.object({ value: z.string() })).optional(),
  descriptions: z.record(z.string(), z.object({ value: z.string() })).optional(),
  sitelinks: z.record(z.string(), z.object({ title: z.string() })).optional(),
  claims: z.record(z.string(), z.array(SnakValueSchema)).optional(),
});
const WikidataEntitiesSchema = z.object({
  entities: z.record(z.string(), WikidataEntitySchema.partial({ id: true })),
});
const WikidataSearchSchema = z.object({ search: z.array(z.object({ id: z.string() })) });
const WikipediaSummarySchema = z.object({
  title: z.string(),
  extract: z.string(),
  content_urls: z.object({ desktop: z.object({ page: z.url() }) }).optional(),
});

const WIKIDATA_PROPERTIES: readonly [string, string][] = [
  ["P571", "Inception"],
  ["P452", "Industry"],
  ["P159", "Headquarters"],
  ["P17", "Country"],
  ["P112", "Founded by"],
  ["P169", "Chief executive officer"],
  ["P1128", "Employees"],
  ["P1056", "Products"],
  ["P749", "Parent organisation"],
  ["P355", "Subsidiaries"],
  ["P127", "Owned by"],
  ["P414", "Stock exchange"],
];

const EntityRefSchema = z.object({ id: z.string().regex(/^Q\d+$/) });
const TimeSchema = z.object({ time: z.string() });
const QuantitySchema = z.object({ amount: z.string() });

function claimValues(entity: z.infer<typeof WikidataEntitySchema>, property: string): unknown[] {
  return (entity.claims?.[property] ?? [])
    .map((claim) => claim.mainsnak.datavalue?.value)
    .filter((value) => value !== undefined);
}

function formatTime(time: string): string {
  const match = /^[+-]?(\d{4,})-(\d{2})-(\d{2})/.exec(time);
  if (match === null) return time;
  const [, year = "", month = "00", day = "00"] = match;
  if (month === "00") return year;
  if (day === "00") return `${year}-${month}`;
  return `${year}-${month}-${day}`;
}

async function wikidataJson<T>(
  env: ResearchEnvironment,
  params: Record<string, string>,
  schema: z.ZodType<T>,
): Promise<T> {
  const url = new URL(WIKIDATA_API);
  for (const [key, value] of Object.entries({ ...params, format: "json" }))
    url.searchParams.set(key, value);
  const document = await fetchDocument(env, url.href, { api: true, accept: JSON_ACCEPT });
  return schema.parse(JSON.parse(document.text));
}

function wikipediaLookup(env: ResearchEnvironment): RegisteredTool {
  return defineTool({
    name: "wikipedia_lookup",
    description:
      "Look the company up on Wikidata and English Wikipedia. Only an entity whose official website is the company's site is accepted. Returns quarantined facts (inception, industry, headquarters, founders, summary).",
    capability: CAPABILITIES.webFetch,
    inputSchema: z.object({ names: z.array(z.string().trim().min(2).max(80)).min(1).max(5) }),
    targetDomain: () => "www.wikidata.org",
    summariseArgs: (input) => `Wikidata/Wikipedia lookup for ${input.names.join(", ")}`,
    execute: async (input, execution) => {
      let match: z.infer<typeof WikidataEntitySchema> | undefined;
      for (const name of input.names.slice(0, RESEARCH_LIMITS.maxNameLookups)) {
        const search = await wikidataJson(
          env,
          { action: "wbsearchentities", search: name, language: "en", type: "item", limit: "5" },
          WikidataSearchSchema,
        );
        const ids = search.search.map((hit) => hit.id).filter((id) => /^Q\d+$/.test(id));
        if (ids.length === 0) continue;
        const entities = await wikidataJson(
          env,
          {
            action: "wbgetentities",
            ids: ids.join("|"),
            props: "claims|sitelinks|labels|descriptions",
            languages: "en",
            sitefilter: "enwiki",
          },
          WikidataEntitiesSchema,
        );
        match = Object.entries(entities.entities)
          .map(([id, entity]) => ({ ...entity, id }))
          .filter((entity) => ids.includes(entity.id))
          .find((entity) =>
            claimValues(entity, "P856").some(
              (value) => typeof value === "string" && env.scope.contains(value),
            ),
          );
        if (match !== undefined) break;
      }
      if (match === undefined) {
        return {
          summary: "No Wikidata entity matches the company site",
          forModel:
            "No Wikidata entity lists this company's site as its official website; nothing was added.",
        };
      }
      const referenced = WIKIDATA_PROPERTIES.flatMap(([property]) => claimValues(match, property))
        .map((value) => EntityRefSchema.safeParse(value))
        .flatMap((parsed) => (parsed.success ? [parsed.data.id] : []))
        .slice(0, 50);
      const labels =
        referenced.length === 0
          ? {}
          : (
              await wikidataJson(
                env,
                {
                  action: "wbgetentities",
                  ids: [...new Set(referenced)].join("|"),
                  props: "labels",
                  languages: "en",
                },
                WikidataEntitiesSchema,
              )
            ).entities;
      const describe = (value: unknown): string | undefined => {
        if (typeof value === "string") return value;
        const ref = EntityRefSchema.safeParse(value);
        if (ref.success) return labels[ref.data.id]?.labels?.en?.value;
        const time = TimeSchema.safeParse(value);
        if (time.success) return formatTime(time.data.time);
        const quantity = QuantitySchema.safeParse(value);
        if (quantity.success) return quantity.data.amount.replace(/^\+/, "");
        return undefined;
      };
      const label = match.labels?.en?.value ?? match.id;
      const lines = [
        `Wikidata entity ${match.id}: ${label}${match.descriptions?.en === undefined ? "" : ` — ${match.descriptions.en.value}`}.`,
      ];
      const website = claimValues(match, "P856").find(
        (value): value is string => typeof value === "string",
      );
      if (website !== undefined) lines.push(`Official website: ${website}`);
      for (const [property, name] of WIKIDATA_PROPERTIES) {
        const values = claimValues(match, property)
          .map(describe)
          .filter((value): value is string => value !== undefined);
        if (values.length > 0)
          lines.push(`${name}: ${[...new Set(values)].slice(0, 8).join("; ")}`);
      }
      const fetchedAt = new Date().toISOString();
      const created: SourceDocument[] = [];
      const wikidata = env.sources.add({
        url: `https://www.wikidata.org/wiki/${match.id}`,
        title: `Wikidata: ${label}`,
        kind: "wikidata",
        fetchedAt,
        text: lines.join("\n"),
      });
      if (wikidata.created) created.push(wikidata.document);
      const title = match.sitelinks?.enwiki?.title;
      if (title !== undefined) {
        const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`;
        const document = await fetchDocument(env, summaryUrl, { api: true, accept: JSON_ACCEPT });
        const summary = WikipediaSummarySchema.parse(JSON.parse(document.text));
        const page = env.sources.add({
          url:
            summary.content_urls?.desktop.page ??
            `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
          title: `Wikipedia: ${summary.title}`,
          kind: "wikipedia",
          fetchedAt: document.fetchedAt,
          text: summary.extract,
        });
        if (page.created) created.push(page.document);
      }
      return outcomeFor(
        env,
        created,
        execution,
        `Matched Wikidata ${match.id} (${label})`,
        `Wikidata and Wikipedia for ${label}`,
      );
    },
  });
}

const GithubOrgSchema = z.object({
  login: z.string(),
  name: z.string().nullish(),
  blog: z.string().nullish(),
  description: z.string().nullish(),
  public_repos: z.number().int().nonnegative().optional(),
  html_url: z.url(),
});
const GithubRepoSchema = z.object({
  name: z.string(),
  description: z.string().nullish(),
  language: z.string().nullish(),
  stargazers_count: z.number().int().nonnegative(),
  fork: z.boolean(),
  archived: z.boolean().optional(),
  html_url: z.url(),
});

function normaliseBlog(blog: string): string {
  return /^https?:\/\//i.test(blog) ? blog : `https://${blog}`;
}

function githubOrg(env: ResearchEnvironment): RegisteredTool {
  return defineTool({
    name: "github_org",
    description:
      "Read the company's public GitHub organisation (unauthenticated API): repositories, languages and stars, as tech-stack signals. Only orgs linked from the company site or whose profile links to it are accepted.",
    capability: CAPABILITIES.webFetch,
    inputSchema: z.object({ org: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/) }),
    targetDomain: () => "api.github.com",
    summariseArgs: (input) => `GitHub org ${input.org}`,
    execute: async (input, execution) => {
      const orgDocument = await fetchDocument(env, `https://api.github.com/orgs/${input.org}`, {
        api: true,
        accept: "application/vnd.github+json",
      });
      const org = GithubOrgSchema.parse(JSON.parse(orgDocument.text));
      const linkedFromSite = env.discoveries.githubOrgs.includes(input.org.toLowerCase());
      const linksToSite =
        org.blog !== undefined &&
        org.blog !== null &&
        org.blog.trim() !== "" &&
        env.scope.contains(normaliseBlog(org.blog.trim()));
      if (!linkedFromSite && !linksToSite) {
        throw new Error(
          `GitHub org ${input.org} is not verifiably the company's: not linked from ${env.scope.root} and its profile does not link back`,
        );
      }
      const reposDocument = await fetchDocument(
        env,
        `https://api.github.com/orgs/${input.org}/repos?per_page=100&sort=pushed`,
        { api: true, accept: "application/vnd.github+json" },
      );
      const repos = z
        .array(GithubRepoSchema)
        .parse(JSON.parse(reposDocument.text))
        .filter((repo) => !repo.fork && repo.archived !== true);
      const languages = new Map<string, { count: number; stars: number }>();
      for (const repo of repos) {
        if (repo.language === undefined || repo.language === null) continue;
        const entry = languages.get(repo.language) ?? { count: 0, stars: 0 };
        languages.set(repo.language, {
          count: entry.count + 1,
          stars: entry.stars + repo.stargazers_count,
        });
      }
      const topLanguages = [...languages.entries()]
        .sort(([, a], [, b]) => b.count - a.count || b.stars - a.stars)
        .slice(0, 8)
        .map(([language, entry]) => `${language} (${entry.count})`);
      const topRepos = [...repos]
        .sort((a, b) => b.stargazers_count - a.stargazers_count)
        .slice(0, 8);
      const lines = [
        `GitHub organisation ${org.login}${org.name === undefined || org.name === null ? "" : ` (${org.name})`}${org.description === undefined || org.description === null ? "" : `: ${org.description}`}`,
        ...(org.public_repos === undefined ? [] : [`Public repositories: ${org.public_repos}`]),
        `Top languages: ${topLanguages.length === 0 ? "none listed" : topLanguages.join(", ")}`,
        "Most starred repositories:",
        ...topRepos.map(
          (repo) =>
            `- ${repo.name} (${repo.language ?? "unknown language"}, ${repo.stargazers_count} stars)${repo.description === undefined || repo.description === null ? "" : `: ${repo.description}`}`,
        ),
      ];
      const stored = env.sources.add({
        url: org.html_url,
        title: `GitHub: ${org.login}`,
        kind: "github",
        fetchedAt: reposDocument.fetchedAt,
        text: lines.join("\n"),
      });
      return outcomeFor(
        env,
        stored.created ? [stored.document] : [],
        execution,
        `Read ${repos.length} repositories of ${org.login}`,
        `GitHub ${org.login}`,
      );
    },
  });
}

function readFeed(env: ResearchEnvironment): RegisteredTool {
  return defineTool({
    name: "read_feed",
    description:
      "Read an RSS or Atom feed published on the company's own site and return its most recent items as quarantined facts (recent news).",
    capability: CAPABILITIES.webFetch,
    inputSchema: z.object({ url: z.string().min(1).max(2048) }),
    targetDomain: (input) => hostOf(input.url),
    summariseArgs: (input) => `feed ${input.url}`,
    execute: async (input, execution) => {
      if (!env.scope.contains(input.url))
        throw new Error(`Feed URL is outside the research scope (${env.scope.root})`);
      const document = await fetchDocument(env, input.url, {
        accept: "application/rss+xml,application/atom+xml,application/xml,text/xml",
      });
      const items = parseFeed(document.text, RESEARCH_LIMITS.maxFeedItems);
      const lines = items.map(
        (item) =>
          `- ${item.published === undefined ? "undated" : item.published.slice(0, 10)}: ${item.title}${item.summary === undefined ? "" : ` — ${item.summary}`}${item.link === undefined ? "" : ` (${item.link})`}`,
      );
      const stored = env.sources.add({
        url: document.finalUrl,
        title: `Feed: ${document.finalUrl}`,
        kind: "feed",
        fetchedAt: document.fetchedAt,
        text: `Recent feed items:\n${lines.join("\n")}`,
      });
      return outcomeFor(
        env,
        stored.created && items.length > 0 ? [stored.document] : [],
        execution,
        `Read ${items.length} feed item${items.length === 1 ? "" : "s"}`,
        `Feed ${document.finalUrl}`,
      );
    },
  });
}

export function createResearchTools(env: ResearchEnvironment): RegisteredTool[] {
  return [crawlSite(env), fetchPage(env), wikipediaLookup(env), githubOrg(env), readFeed(env)];
}
