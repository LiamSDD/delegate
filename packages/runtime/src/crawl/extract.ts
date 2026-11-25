import { z } from "zod";

import { detectInjection } from "../quarantine/reader";
import {
  decodeEntities,
  htmlToText,
  isHidden,
  parseAttributes,
  type HtmlDocument,
} from "../tools/html";
import { detectLanguage } from "./language";

interface ElementNode {
  tag: string;
  attributes: Map<string, string>;
  children: TreeNode[];
}

type TreeNode = ElementNode | string;

export interface StructuredData {
  organization?: Record<string, string>;
  products: Record<string, string>[];
  addresses: string[];
  openGraph: Record<string, string>;
}

export interface MetaRobots {
  noindex: boolean;
  nofollow: boolean;
}

export interface ExtractedPage extends HtmlDocument {
  mainText: string;
  extraction: "main" | "article" | "density" | "body";
  structured: StructuredData;
  structuredLines: string[];
  language: string;
  robots: MetaRobots;
  mainLinks: Set<string>;
}

const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const RAW_TEXT = new Set(["script", "style", "noscript", "title", "textarea", "xmp", "iframe"]);
const DROPPED = new Set([
  "template",
  "svg",
  "math",
  "object",
  "canvas",
  "select",
  "button",
  "form",
  "nav",
  "footer",
  "aside",
  "dialog",
  "video",
  "audio",
  "picture",
  "figure-ad",
]);
const BLOCK = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "ul",
  "html",
]);
const CLOSES_P = new Set([...BLOCK, "table", "ul", "ol"]);
const BOILERPLATE =
  /(^|[\s_-])(nav|navbar|navigation|menu|menubar|megamenu|footer|site-footer|sidebar|breadcrumbs?|cookie|cookies|consent|gdpr-banner|banner|newsletter|subscribe|social|share|sharing|modal|popup|overlay|related|recommended|comments?|advert|ads|sponsor|promo-bar|skip-link|skiplink|toolbar|pagination|pager)([\s_-]|$)/i;
const BOILERPLATE_ROLES = new Set([
  "navigation",
  "banner",
  "contentinfo",
  "complementary",
  "search",
  "dialog",
  "alertdialog",
  "menu",
  "menubar",
]);
const MAX_STRUCTURED_LINES = 24;
const MAX_STRUCTURED_VALUE = 200;
const MIN_MAIN_CHARS = 140;
const MAX_TREE_DEPTH = 200;
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/y;

function element(tag: string, attributes = new Map<string, string>()): ElementNode {
  return { tag, attributes, children: [] };
}

function parseTree(html: string): { root: ElementNode; jsonLd: string[] } {
  const root = element("#root");
  const stack: ElementNode[] = [root];
  const jsonLd: string[] = [];
  const top = () => stack[stack.length - 1] ?? root;
  const close = (tag: string) => {
    for (let index = stack.length - 1; index > 0; index -= 1) {
      if (stack[index]?.tag === tag) {
        stack.length = index;
        return;
      }
    }
  };
  let index = 0;
  while (index < html.length) {
    const lt = html.indexOf("<", index);
    if (lt === -1) {
      top().children.push(html.slice(index));
      break;
    }
    if (lt > index) top().children.push(html.slice(index, lt));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html[lt + 1] === "!" || html[lt + 1] === "?") {
      const end = html.indexOf(">", lt);
      index = end === -1 ? html.length : end + 1;
      continue;
    }
    TAG.lastIndex = lt;
    const match = TAG.exec(html);
    if (match === null) {
      top().children.push("<");
      index = lt + 1;
      continue;
    }
    index = lt + match[0].length;
    const tag = (match[2] ?? "").toLowerCase();
    const raw = match[3] ?? "";
    if (match[1] === "/") {
      close(tag);
      continue;
    }
    const attributes = parseAttributes(raw);
    if (RAW_TEXT.has(tag)) {
      const pattern = new RegExp(`</${tag}\\s*>`, "gi");
      pattern.lastIndex = index;
      const end = pattern.exec(html);
      const content = html.slice(index, end === null ? html.length : end.index);
      if (tag === "script" && /ld\+json/i.test(attributes.get("type") ?? "")) jsonLd.push(content);
      index = end === null ? html.length : end.index + end[0].length;
      continue;
    }
    const current = top();
    if (current.tag === "p" && CLOSES_P.has(tag)) stack.pop();
    if ((tag === "li" || tag === "dt" || tag === "dd" || tag === "tr") && top().tag === tag)
      stack.pop();
    if ((tag === "td" || tag === "th") && (top().tag === "td" || top().tag === "th")) stack.pop();
    const node = element(tag, attributes);
    top().children.push(node);
    if (!VOID.has(tag) && !raw.trim().endsWith("/") && stack.length < MAX_TREE_DEPTH)
      stack.push(node);
  }
  return { root, jsonLd };
}

function isBoilerplate(node: ElementNode): boolean {
  if (isHidden(node.attributes)) return true;
  if (DROPPED.has(node.tag)) return true;
  const role = (node.attributes.get("role") ?? "").toLowerCase();
  if (BOILERPLATE_ROLES.has(role)) return true;
  if (node.tag === "header" && !containsTag(node, "h1")) return true;
  if (node.tag === "body" || node.tag === "main" || node.tag === "article" || role === "main")
    return false;
  const label = `${node.attributes.get("class") ?? ""} ${node.attributes.get("id") ?? ""}`;
  return BOILERPLATE.test(label) && !containsMainContent(node);
}

function containsTag(node: ElementNode, tag: string): boolean {
  return node.children.some(
    (child) => typeof child !== "string" && (child.tag === tag || containsTag(child, tag)),
  );
}

function containsMainContent(node: ElementNode): boolean {
  return node.children.some(
    (child) =>
      typeof child !== "string" &&
      (child.tag === "main" ||
        child.tag === "article" ||
        child.attributes.get("role") === "main" ||
        containsMainContent(child)),
  );
}

function prune(node: ElementNode): ElementNode {
  return {
    ...node,
    children: node.children.flatMap((child): TreeNode[] => {
      if (typeof child === "string") return [child];
      if (isBoilerplate(child)) return [];
      return [prune(child)];
    }),
  };
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function inlineText(node: TreeNode): string {
  if (typeof node === "string") return decodeEntities(node);
  if (node.tag === "br") return " ";
  return node.children.map(inlineText).join(node.tag === "td" || node.tag === "th" ? " " : "");
}

interface TextStats {
  chars: number;
  linkChars: number;
  paragraphs: number;
}

function stats(node: TreeNode, inLink = false): TextStats {
  if (typeof node === "string") {
    const chars = collapse(decodeEntities(node)).length;
    return { chars, linkChars: inLink ? chars : 0, paragraphs: 0 };
  }
  const total: TextStats = { chars: 0, linkChars: 0, paragraphs: node.tag === "p" ? 1 : 0 };
  for (const child of node.children) {
    const childStats = stats(child, inLink || node.tag === "a");
    total.chars += childStats.chars;
    total.linkChars += childStats.linkChars;
    total.paragraphs += childStats.paragraphs;
  }
  return total;
}

function find(node: ElementNode, predicate: (node: ElementNode) => boolean): ElementNode[] {
  const found: ElementNode[] = [];
  const visit = (current: ElementNode) => {
    if (predicate(current)) found.push(current);
    for (const child of current.children) if (typeof child !== "string") visit(child);
  };
  visit(node);
  return found;
}

function densest(root: ElementNode): ElementNode | undefined {
  let best: { node: ElementNode; score: number } | undefined;
  for (const node of find(root, (candidate) =>
    ["div", "section", "td", "body", "article", "main"].includes(candidate.tag),
  )) {
    const s = stats(node);
    if (s.chars < MIN_MAIN_CHARS) continue;
    const linkDensity = s.chars === 0 ? 1 : s.linkChars / s.chars;
    const score = (s.chars - s.linkChars) * (1 - linkDensity) + s.paragraphs * 40;
    if (best === undefined || score > best.score) best = { node, score };
  }
  return best?.node;
}

function renderTable(table: ElementNode): string {
  const rows = find(table, (node) => node.tag === "tr");
  const lines: string[] = [];
  rows.forEach((row, rowIndex) => {
    const cells = row.children.filter(
      (cell): cell is ElementNode =>
        typeof cell !== "string" && (cell.tag === "td" || cell.tag === "th"),
    );
    if (cells.length === 0) return;
    const values = cells.map((cell) => collapse(inlineText(cell)).replace(/\|/g, "/"));
    if (values.every((value) => value === "")) return;
    lines.push(`| ${values.join(" | ")} |`);
    if (rowIndex === 0 && cells.every((cell) => cell.tag === "th"))
      lines.push(`| ${values.map(() => "---").join(" | ")} |`);
  });
  return lines.join("\n");
}

function render(root: ElementNode): string {
  const blocks: string[] = [];
  let line = "";
  let prefix = "";
  const flush = () => {
    const text = collapse(line);
    if (text !== "") blocks.push(`${prefix}${text}`);
    line = "";
    prefix = "";
  };
  const visit = (node: TreeNode, listDepth: number) => {
    if (typeof node === "string") {
      line += decodeEntities(node);
      return;
    }
    const heading = /^h([1-6])$/.exec(node.tag)?.[1];
    if (heading !== undefined) {
      flush();
      prefix = `${"#".repeat(Number(heading))} `;
      line = inlineText(node);
      flush();
      return;
    }
    if (node.tag === "table") {
      flush();
      const table = renderTable(node);
      if (table !== "") blocks.push(table);
      return;
    }
    if (node.tag === "pre") {
      flush();
      const code = inlineText(node).trim();
      if (code !== "") blocks.push(code);
      return;
    }
    if (node.tag === "br") {
      line += " ";
      return;
    }
    if (node.tag === "li") {
      flush();
      prefix = `${"  ".repeat(Math.max(0, listDepth - 1))}- `;
      for (const child of node.children) {
        if (typeof child !== "string" && (child.tag === "ul" || child.tag === "ol")) {
          flush();
          visit(child, listDepth + 1);
        } else visit(child, listDepth);
      }
      flush();
      return;
    }
    const block = BLOCK.has(node.tag) || node.tag === "tr";
    if (block) flush();
    const nextDepth = node.tag === "ul" || node.tag === "ol" ? listDepth + 1 : listDepth;
    for (const child of node.children) visit(child, nextDepth);
    if (block) flush();
  };
  visit(root, 0);
  flush();
  const merged: string[] = [];
  for (const block of blocks) {
    const previous = merged[merged.length - 1];
    if (
      previous !== undefined &&
      /^\s*- /.test(block) &&
      /^\s*- /.test(previous.split("\n").at(-1) ?? "")
    )
      merged[merged.length - 1] = `${previous}\n${block}`;
    else merged.push(block);
  }
  return merged.join("\n\n");
}

const JsonLdSchema = z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]);

function text(value: unknown): string | undefined {
  if (typeof value === "string") {
    const cleaned = collapse(decodeEntities(value.replace(/<[^>]*>/g, " ")));
    return cleaned === "" ? undefined : cleaned.slice(0, MAX_STRUCTURED_VALUE);
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) {
    const parts = value.map(text).filter((part): part is string => part !== undefined);
    return parts.length === 0
      ? undefined
      : parts.slice(0, 5).join(", ").slice(0, MAX_STRUCTURED_VALUE);
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return text(record.name ?? record["@value"] ?? record.value);
  }
  return undefined;
}

function types(node: Record<string, unknown>): string[] {
  const raw = node["@type"];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter((value): value is string => typeof value === "string");
}

function addressText(value: unknown): string | undefined {
  if (typeof value === "string") return text(value);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const parts = [
    record.streetAddress,
    record.postalCode,
    record.addressLocality,
    record.addressRegion,
    record.addressCountry,
  ]
    .map(text)
    .filter((part): part is string => part !== undefined);
  return parts.length === 0 ? undefined : parts.join(", ");
}

function pick(record: Record<string, unknown>, fields: readonly string[]): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const field of fields) {
    const value = text(record[field]);
    if (value !== undefined) picked[field] = value;
  }
  return picked;
}

const ORGANIZATION_TYPES =
  /^(Organization|Corporation|LocalBusiness|Company|NGO|EducationalOrganization|OnlineBusiness|OnlineStore|Store|ProfessionalService|SoftwareCompany)$/;
const PRODUCT_TYPES =
  /^(Product|SoftwareApplication|WebApplication|MobileApplication|Service|Offer)$/;

function walkJsonLd(
  value: unknown,
  visit: (node: Record<string, unknown>) => void,
  depth = 0,
): void {
  if (depth > 6 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 50)) walkJsonLd(item, visit, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  visit(record);
  for (const [key, child] of Object.entries(record)) {
    if (key === "@context") continue;
    walkJsonLd(child, visit, depth + 1);
  }
}

function structuredFromJsonLd(blocks: readonly string[], data: StructuredData): void {
  for (const block of blocks.slice(0, 10)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block.trim());
    } catch {
      continue;
    }
    const shaped = JsonLdSchema.safeParse(parsed);
    if (!shaped.success) continue;
    walkJsonLd(shaped.data, (node) => {
      const nodeTypes = types(node);
      if (
        nodeTypes.some((type) => ORGANIZATION_TYPES.test(type)) &&
        data.organization === undefined
      ) {
        const organization = pick(node, [
          "name",
          "legalName",
          "alternateName",
          "description",
          "url",
          "foundingDate",
          "founder",
          "numberOfEmployees",
          "slogan",
          "sameAs",
          "areaServed",
          "industry",
        ]);
        const address = addressText(node.address);
        if (address !== undefined) organization.address = address;
        if (Object.keys(organization).length > 0) data.organization = organization;
      }
      if (nodeTypes.some((type) => PRODUCT_TYPES.test(type)) && data.products.length < 10) {
        const product = pick(node, [
          "name",
          "description",
          "brand",
          "category",
          "applicationCategory",
          "operatingSystem",
          "price",
          "priceCurrency",
        ]);
        const offers = node.offers;
        const offer = Array.isArray(offers) ? (offers[0] as unknown) : offers;
        if (typeof offer === "object" && offer !== null) {
          const offerFields = pick(offer as Record<string, unknown>, [
            "price",
            "lowPrice",
            "highPrice",
            "priceCurrency",
          ]);
          Object.assign(product, offerFields);
        }
        if (product.name !== undefined || product.price !== undefined) data.products.push(product);
      }
      if (nodeTypes.includes("PostalAddress")) {
        const address = addressText(node);
        if (address !== undefined && !data.addresses.includes(address) && data.addresses.length < 5)
          data.addresses.push(address);
      }
    });
  }
}

const META_KEYS = new Set([
  "og:title",
  "og:type",
  "og:site_name",
  "og:description",
  "og:locale",
  "twitter:site",
  "product:price:amount",
  "product:price:currency",
  "article:published_time",
  "article:modified_time",
]);

function metaTags(html: string): { meta: Record<string, string>; robots: MetaRobots } {
  const meta: Record<string, string> = {};
  const robots: MetaRobots = { noindex: false, nofollow: false };
  const head = html.slice(0, 200_000);
  for (const match of head.matchAll(/<meta\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
    const attributes = parseAttributes(match[1] ?? "");
    const key = (attributes.get("property") ?? attributes.get("name") ?? "").toLowerCase();
    const content = collapse(attributes.get("content") ?? "");
    if (content === "") continue;
    if (key === "robots" || key === "delegatebot") {
      const directives = new Set(
        content
          .toLowerCase()
          .split(/[,\s]+/)
          .filter((directive) => directive !== ""),
      );
      if (directives.has("noindex") || directives.has("none")) robots.noindex = true;
      if (directives.has("nofollow") || directives.has("none")) robots.nofollow = true;
    }
    if (META_KEYS.has(key) && meta[key] === undefined)
      meta[key] = content.slice(0, MAX_STRUCTURED_VALUE);
  }
  return { meta, robots };
}

const LABELS: Record<string, string> = {
  name: "name",
  legalName: "legal name",
  alternateName: "also known as",
  description: "description",
  url: "website",
  foundingDate: "founded",
  founder: "founder",
  numberOfEmployees: "employees",
  slogan: "slogan",
  sameAs: "profiles",
  areaServed: "area served",
  industry: "industry",
  address: "address",
  brand: "brand",
  category: "category",
  applicationCategory: "category",
  operatingSystem: "platforms",
  price: "price",
  lowPrice: "from",
  highPrice: "up to",
  priceCurrency: "currency",
};

function structuredLines(data: StructuredData): string[] {
  const lines: string[] = [];
  const describe = (label: string, record: Record<string, string>) => {
    const parts = Object.entries(record).map(([key, value]) => `${LABELS[key] ?? key}: ${value}`);
    if (parts.length > 0) lines.push(`- ${label}: ${parts.join("; ")}`);
  };
  if (data.organization !== undefined) describe("Organization", data.organization);
  for (const product of data.products) describe("Product or offer", product);
  for (const address of data.addresses) lines.push(`- Address: ${address}`);
  const og = data.openGraph;
  const price = og["product:price:amount"];
  if (price !== undefined)
    lines.push(
      `- Listed price: ${price}${og["product:price:currency"] === undefined ? "" : ` ${og["product:price:currency"]}`}`,
    );
  if (og["article:published_time"] !== undefined)
    lines.push(`- Published: ${og["article:published_time"]}`);
  return lines.slice(0, MAX_STRUCTURED_LINES);
}

function linkHrefs(node: ElementNode, base: string): Set<string> {
  const hrefs = new Set<string>();
  for (const anchor of find(node, (candidate) => candidate.tag === "a")) {
    const href = anchor.attributes.get("href");
    if (href === undefined || href.trim().startsWith("#")) continue;
    try {
      const url = new URL(href.trim(), base);
      url.hash = "";
      hrefs.add(url.href);
    } catch {
      continue;
    }
  }
  return hrefs;
}

export function extractPage(html: string, baseUrl: string): ExtractedPage {
  const document = htmlToText(html, baseUrl);
  const { root, jsonLd } = parseTree(html);
  const body = find(root, (node) => node.tag === "body")[0] ?? root;
  const cleaned = prune(body);
  const bodyChars = stats(cleaned).chars;
  const main = find(
    cleaned,
    (node) => node.tag === "main" || node.attributes.get("role") === "main",
  )[0];
  const articles = find(cleaned, (node) => node.tag === "article");
  let chosen: { node: ElementNode; kind: ExtractedPage["extraction"] } = {
    node: cleaned,
    kind: "body",
  };
  if (main !== undefined && stats(main).chars >= Math.min(MIN_MAIN_CHARS, bodyChars * 0.5)) {
    chosen = { node: main, kind: "main" };
  } else if (
    articles.length === 1 &&
    articles[0] !== undefined &&
    stats(articles[0]).chars >= MIN_MAIN_CHARS
  ) {
    chosen = { node: articles[0], kind: "article" };
  } else {
    const dense = densest(cleaned);
    if (dense !== undefined && stats(dense).chars >= bodyChars * 0.4)
      chosen = { node: dense, kind: "density" };
  }
  let mainText = render(chosen.node);
  if (mainText.length < MIN_MAIN_CHARS && chosen.kind !== "body") {
    const fallback = render(cleaned);
    if (fallback.length > mainText.length) chosen = { node: cleaned, kind: "body" };
    mainText = render(chosen.node);
  }
  if (mainText.trim() === "") mainText = document.text;
  const { meta, robots } = metaTags(html);
  const structured: StructuredData = { products: [], addresses: [], openGraph: meta };
  structuredFromJsonLd(jsonLd, structured);
  const lines: string[] = [];
  const hiddenText = [...document.hiddenText];
  for (const line of structuredLines(structured)) {
    if (detectInjection(line) === undefined) lines.push(line);
    else hiddenText.push(line);
  }
  const language = detectLanguage(mainText, document.lang);
  return {
    ...document,
    hiddenText,
    mainText,
    extraction: chosen.kind,
    structured,
    structuredLines: lines,
    language,
    robots,
    mainLinks: linkHrefs(chosen.node, baseUrl),
  };
}

export function pageSourceText(page: ExtractedPage): string {
  return [
    page.description === undefined ? "" : `Description: ${page.description}`,
    page.mainText,
    page.structuredLines.length === 0
      ? ""
      : `Structured data published by the page:\n${page.structuredLines.join("\n")}`,
  ]
    .filter((part) => part.trim() !== "")
    .join("\n\n");
}
