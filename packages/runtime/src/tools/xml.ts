import { decodeEntities, htmlToText } from "./html";

export interface SitemapEntries {
  urls: string[];
  sitemaps: string[];
}

export interface FeedItem {
  title: string;
  link?: string;
  published?: string;
  summary?: string;
}

const MAX_SUMMARY_CHARS = 400;

function elementText(raw: string): string {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
  return cdata === null ? decodeEntities(raw) : (cdata[1] ?? "");
}

function* eachBlock(xml: string, tag: string): Generator<string> {
  const pattern = new RegExp(
    `<(?:[a-z0-9]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[a-z0-9]+:)?${tag}>`,
    "gi",
  );
  for (const match of xml.matchAll(pattern)) yield match[1] ?? "";
}

function blocks(xml: string, tag: string): string[] {
  return [...eachBlock(xml, tag)];
}

function first(xml: string, tag: string): string | undefined {
  const found = blocks(xml, tag)[0];
  return found === undefined ? undefined : elementText(found);
}

function plain(markup: string): string {
  return htmlToText(markup, "https://invalid.example/").text.replace(/\s+/g, " ").trim();
}

function isoDate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const time = Date.parse(value.trim());
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

export interface SitemapEntry {
  loc: string;
  lastmod?: string;
}

export interface DatedSitemapEntries {
  urls: SitemapEntry[];
  sitemaps: SitemapEntry[];
}

export function parseSitemapEntries(
  xml: string,
  limit = Number.POSITIVE_INFINITY,
): DatedSitemapEntries {
  const entries = (container: string): SitemapEntry[] => {
    const found: SitemapEntry[] = [];
    for (const entry of eachBlock(xml, container)) {
      if (found.length >= limit) break;
      const loc = first(entry, "loc")?.trim();
      if (loc === undefined || loc === "") continue;
      const lastmod = isoDate(first(entry, "lastmod"));
      found.push({ loc, ...(lastmod === undefined ? {} : { lastmod }) });
    }
    return found;
  };
  return { urls: entries("url"), sitemaps: entries("sitemap") };
}

export function parseSitemap(xml: string): SitemapEntries {
  const locs = (container: string) =>
    blocks(xml, container)
      .map((entry) => first(entry, "loc")?.trim())
      .filter((loc): loc is string => loc !== undefined && loc !== "");
  return { urls: locs("url"), sitemaps: locs("sitemap") };
}

function atomLink(entry: string): string | undefined {
  const links = [...entry.matchAll(/<link\b([^>]*)\/?>/gi)].map((match) => match[1] ?? "");
  const preferred =
    links.find((attributes) => /rel\s*=\s*["']alternate["']/i.test(attributes)) ??
    links.find((attributes) => !/rel\s*=/i.test(attributes)) ??
    links[0];
  const href =
    preferred === undefined ? undefined : /href\s*=\s*["']([^"']+)["']/i.exec(preferred)?.[1];
  return href === undefined ? undefined : decodeEntities(href);
}

export function parseFeed(xml: string, limit = 10): FeedItem[] {
  const rss = blocks(xml, "item");
  const entries = rss.length > 0 ? rss : blocks(xml, "entry");
  const items: FeedItem[] = [];
  for (const entry of entries) {
    const title = plain(first(entry, "title") ?? "");
    if (title === "") continue;
    const rawLink = rss.length > 0 ? first(entry, "link")?.trim() : atomLink(entry);
    const published = isoDate(
      first(entry, "pubDate") ??
        first(entry, "published") ??
        first(entry, "updated") ??
        first(entry, "date"),
    );
    const summaryMarkup = first(entry, "description") ?? first(entry, "summary");
    const summary =
      summaryMarkup === undefined ? "" : plain(summaryMarkup).slice(0, MAX_SUMMARY_CHARS);
    items.push({
      title,
      ...(rawLink === undefined || rawLink === "" ? {} : { link: rawLink }),
      ...(published === undefined ? {} : { published }),
      ...(summary === "" ? {} : { summary }),
    });
  }
  items.sort((a, b) => (b.published ?? "").localeCompare(a.published ?? ""));
  return items.slice(0, limit);
}
