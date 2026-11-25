export interface HtmlLink {
  href: string;
  text: string;
}

export interface HtmlFeed {
  href: string;
  type: "rss" | "atom";
  title?: string;
}

export interface HtmlDocument {
  title: string;
  description?: string;
  siteName?: string;
  canonical?: string;
  lang?: string;
  text: string;
  headings: { level: number; text: string }[];
  links: HtmlLink[];
  feeds: HtmlFeed[];
  sitemapHints: string[];
  hiddenText: string[];
}

const VOID_ELEMENTS = new Set([
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
const RAW_TEXT_ELEMENTS = new Set([
  "script",
  "style",
  "noscript",
  "title",
  "textarea",
  "xmp",
  "iframe",
]);
const SKIPPED_SUBTREES = new Set(["template", "svg", "math", "object", "canvas", "select"]);
const BLOCK_ELEMENTS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "dd",
  "details",
  "dialog",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
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
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
  "html",
  "head",
]);
const HIDDEN_STYLE =
  /(display:none|visibility:hidden|font-size:0(px|em|rem|%)?(;|!|$)|opacity:0(\.0+)?(;|!|$))/;
const HIDDEN_CLASSES = new Set(["hidden", "d-none", "invisible", "is-hidden"]);
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/y;
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
const MAX_HIDDEN_SNIPPETS = 50;
const MAX_HIDDEN_SNIPPET_CHARS = 500;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
  copy: "©",
  reg: "®",
  trade: "™",
  middot: "·",
  bull: "•",
  laquo: "«",
  raquo: "»",
  euro: "€",
  pound: "£",
  times: "×",
  deg: "°",
  shy: "",
  zwj: "",
  zwnj: "",
  auml: "ä",
  ouml: "ö",
  uuml: "ü",
  Auml: "Ä",
  Ouml: "Ö",
  Uuml: "Ü",
  szlig: "ß",
  eacute: "é",
  egrave: "è",
  aacute: "á",
  agrave: "à",
  ccedil: "ç",
  ntilde: "ñ",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    if (body.startsWith("#")) {
      const code =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number(body.slice(1));
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function parseAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of source.matchAll(ATTRIBUTE)) {
    const name = match[1]?.toLowerCase();
    if (name === undefined || attributes.has(name)) continue;
    attributes.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ""));
  }
  return attributes;
}

export function isHidden(attributes: Map<string, string>): boolean {
  if (attributes.has("hidden")) return true;
  if (attributes.get("aria-hidden")?.trim().toLowerCase() === "true") return true;
  const style = (attributes.get("style") ?? "").toLowerCase().replace(/\s+/g, "");
  if (HIDDEN_STYLE.test(style)) return true;
  const classes = (attributes.get("class") ?? "").toLowerCase().split(/\s+/);
  return classes.some((name) => HIDDEN_CLASSES.has(name));
}

function absolute(href: string | undefined, base: string): string | undefined {
  if (href === undefined || href.trim() === "" || href.trim().startsWith("#")) return undefined;
  try {
    const url = new URL(href.trim(), base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

function findClosing(
  html: string,
  name: string,
  from: number,
): { contentEnd: number; next: number } {
  const pattern = new RegExp(`</${name}\\s*>`, "gi");
  pattern.lastIndex = from;
  const match = pattern.exec(html);
  if (match === null) return { contentEnd: html.length, next: html.length };
  return { contentEnd: match.index, next: match.index + match[0].length };
}

function skipSubtree(html: string, name: string, from: number): number {
  const pattern = new RegExp(`<(/?)${name}(?=[\\s/>])[^>]*>`, "gi");
  pattern.lastIndex = from;
  let depth = 1;
  for (let match = pattern.exec(html); match !== null; match = pattern.exec(html)) {
    if (match[1] === "/") depth -= 1;
    else if (!match[0].endsWith("/>")) depth += 1;
    if (depth === 0) return match.index + match[0].length;
  }
  return html.length;
}

interface OpenElement {
  name: string;
  hidden: boolean;
}

export function htmlToText(html: string, baseUrl: string): HtmlDocument {
  const result: HtmlDocument = {
    title: "",
    text: "",
    headings: [],
    links: [],
    feeds: [],
    sitemapHints: [],
    hiddenText: [],
  };
  const stack: OpenElement[] = [];
  const blocks: string[] = [];
  let block: string[] = [];
  let line = "";
  let prefix = "";
  let hiddenDepth = 0;
  let hiddenBuffer = "";
  let heading: { level: number; text: string } | undefined;
  let link: { href: string; text: string } | undefined;
  const seenLinks = new Set<string>();
  let base = baseUrl;

  const endLine = () => {
    const text = collapse(line);
    if (text !== "") block.push(text);
    line = "";
  };
  const flushBlock = () => {
    endLine();
    if (block.length > 0) blocks.push(`${prefix}${block.join("\n")}`);
    block = [];
    prefix = "";
  };
  const flushHidden = () => {
    const text = collapse(hiddenBuffer);
    hiddenBuffer = "";
    if (text !== "" && result.hiddenText.length < MAX_HIDDEN_SNIPPETS) {
      result.hiddenText.push(text.slice(0, MAX_HIDDEN_SNIPPET_CHARS));
    }
  };
  const addText = (raw: string) => {
    const text = decodeEntities(raw);
    if (hiddenDepth > 0) {
      hiddenBuffer += text;
      return;
    }
    line += text;
    if (heading !== undefined) heading.text += text;
    if (link !== undefined) link.text += text;
  };
  const finishLink = () => {
    if (link === undefined) return;
    const text = collapse(link.text);
    if (!seenLinks.has(link.href)) {
      seenLinks.add(link.href);
      result.links.push({ href: link.href, text });
    }
    link = undefined;
  };
  const popElement = () => {
    const element = stack.pop();
    if (element === undefined) return;
    if (element.name === "a") finishLink();
    if (/^h[1-6]$/.test(element.name) && heading !== undefined) {
      const text = collapse(heading.text);
      if (text !== "") result.headings.push({ level: heading.level, text });
      heading = undefined;
    }
    if (element.hidden) {
      hiddenDepth -= 1;
      if (hiddenDepth === 0) flushHidden();
    }
    if (BLOCK_ELEMENTS.has(element.name) && hiddenDepth === 0) flushBlock();
  };
  const closeElement = (name: string) => {
    const index = stack.map((element) => element.name).lastIndexOf(name);
    if (index === -1) return;
    while (stack.length > index) popElement();
  };

  const handleHead = (name: string, attributes: Map<string, string>) => {
    if (name === "html") {
      const lang = attributes.get("lang");
      if (lang !== undefined && lang !== "") result.lang = lang;
    }
    if (name === "base") {
      const href = absolute(attributes.get("href"), baseUrl);
      if (href !== undefined) base = href;
    }
    if (name === "meta") {
      const key = (attributes.get("name") ?? attributes.get("property") ?? "").toLowerCase();
      const content = collapse(attributes.get("content") ?? "");
      if (content === "") return;
      if (key === "description") result.description = content;
      if (key === "og:description" && result.description === undefined)
        result.description = content;
      if (key === "og:site_name") result.siteName = content;
    }
    if (name === "link") {
      const rel = (attributes.get("rel") ?? "").toLowerCase().split(/\s+/);
      const href = absolute(attributes.get("href"), base);
      if (href === undefined) return;
      const type = (attributes.get("type") ?? "").toLowerCase();
      if (rel.includes("canonical")) result.canonical = href;
      if (rel.includes("sitemap")) result.sitemapHints.push(href);
      if (rel.includes("alternate") && (type.includes("rss") || type.includes("atom"))) {
        const title = collapse(attributes.get("title") ?? "");
        result.feeds.push({
          href,
          type: type.includes("atom") ? "atom" : "rss",
          ...(title === "" ? {} : { title }),
        });
      }
    }
  };

  const openElement = (name: string, attributes: Map<string, string>, selfClosing: boolean) => {
    handleHead(name, attributes);
    if (BLOCK_ELEMENTS.has(name) && stack.at(-1)?.name === "p") popElement();
    if ((name === "li" || name === "dt" || name === "dd") && stack.at(-1)?.name === name)
      popElement();
    if (name === "br") {
      if (hiddenDepth === 0) endLine();
      return;
    }
    if (VOID_ELEMENTS.has(name) || selfClosing) {
      if (BLOCK_ELEMENTS.has(name) && hiddenDepth === 0) flushBlock();
      return;
    }
    const hidden = isHidden(attributes);
    if (BLOCK_ELEMENTS.has(name) && hiddenDepth === 0 && !hidden) flushBlock();
    if (hidden) {
      if (hiddenDepth === 0) endLine();
      hiddenDepth += 1;
    }
    stack.push({ name, hidden });
    if (hiddenDepth > 0) return;
    const level = /^h([1-6])$/.exec(name)?.[1];
    if (level !== undefined) {
      prefix = `${"#".repeat(Number(level))} `;
      heading = { level: Number(level), text: "" };
    }
    if (name === "li") prefix = "- ";
    if (name === "a") {
      finishLink();
      const href = absolute(attributes.get("href"), base);
      if (href !== undefined) {
        if (/sitemap[^/]*\.xml$/i.test(new URL(href).pathname)) result.sitemapHints.push(href);
        link = { href, text: "" };
      }
    }
  };

  let index = 0;
  while (index < html.length) {
    const lt = html.indexOf("<", index);
    if (lt === -1) {
      addText(html.slice(index));
      break;
    }
    if (lt > index) addText(html.slice(index, lt));
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
      addText("<");
      index = lt + 1;
      continue;
    }
    index = lt + match[0].length;
    const closing = match[1] === "/";
    const name = (match[2] ?? "").toLowerCase();
    const rawAttributes = match[3] ?? "";
    if (closing) {
      closeElement(name);
      continue;
    }
    const attributes = parseAttributes(rawAttributes);
    if (RAW_TEXT_ELEMENTS.has(name)) {
      const { contentEnd, next } = findClosing(html, name, index);
      if (name === "title" && result.title === "") {
        result.title = collapse(decodeEntities(html.slice(index, contentEnd)));
      }
      index = next;
      continue;
    }
    if (SKIPPED_SUBTREES.has(name)) {
      if (!rawAttributes.trim().endsWith("/")) index = skipSubtree(html, name, index);
      continue;
    }
    openElement(name, attributes, rawAttributes.trim().endsWith("/"));
  }
  while (stack.length > 0) popElement();
  if (hiddenBuffer !== "") flushHidden();
  flushBlock();
  result.text = blocks.join("\n\n");
  result.sitemapHints = [...new Set(result.sitemapHints)];
  return result;
}
