import { Marked, type MarkedToken, type Token, type Tokens } from "marked";

import { createSlugger } from "./slug";

const marked = new Marked({ gfm: true });

const MARKED_TYPES: ReadonlySet<string> = new Set<MarkedToken["type"]>([
  "blockquote",
  "br",
  "checkbox",
  "code",
  "codespan",
  "def",
  "del",
  "em",
  "escape",
  "heading",
  "hr",
  "html",
  "image",
  "link",
  "list",
  "list_item",
  "paragraph",
  "space",
  "strong",
  "table",
  "text",
]);

export function asMarkedToken(token: Token): MarkedToken | null {
  return MARKED_TYPES.has(token.type) ? (token as MarkedToken) : null;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  middot: "·",
  times: "×",
  rarr: "→",
  larr: "←",
  euro: "€",
  le: "≤",
  ge: "≥",
};

function codePoint(value: number, fallback: string): string {
  if (!Number.isInteger(value) || value <= 0 || value > 0x10ffff) return fallback;
  if (value >= 0xd800 && value <= 0xdfff) return fallback;
  return String.fromCodePoint(value);
}

export function decodeEntities(text: string): string {
  return text.replace(
    /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));/g,
    (match: string, decimal?: string, hex?: string, name?: string) => {
      if (decimal !== undefined) return codePoint(Number.parseInt(decimal, 10), match);
      if (hex !== undefined) return codePoint(Number.parseInt(hex, 16), match);
      return (name === undefined ? undefined : NAMED_ENTITIES[name]) ?? match;
    },
  );
}

const LINE_BREAK_TAG = /^<br\s*\/?>$/i;
const HTML_COMMENT = /^<!--[\s\S]*?-->$/;
const DIRECTIVE = /^<!--\s*live:([a-z][a-z0-9-]*)\s*-->$/;

export function isLineBreakTag(html: string): boolean {
  return LINE_BREAK_TAG.test(html.trim());
}

export function isHtmlComment(html: string): boolean {
  return HTML_COMMENT.test(html.trim());
}

export function directiveName(html: string): string | null {
  return DIRECTIVE.exec(html.trim())?.[1] ?? null;
}

function genericChildren(token: Token): Token[] {
  return "tokens" in token && Array.isArray(token.tokens) ? token.tokens : [];
}

export function childTokens(token: Token): Token[] {
  const known = asMarkedToken(token);
  if (known === null) return genericChildren(token);
  switch (known.type) {
    case "list":
      return known.items;
    case "table":
      return [...known.header, ...known.rows.flat()].flatMap((cell) => cell.tokens);
    case "blockquote":
    case "del":
    case "em":
    case "heading":
    case "image":
    case "link":
    case "list_item":
    case "paragraph":
    case "strong":
      return known.tokens;
    case "text":
      return known.tokens ?? [];
    default:
      return [];
  }
}

export function walkTokens(tokens: readonly Token[], visit: (token: Token) => void): void {
  for (const token of tokens) {
    visit(token);
    walkTokens(childTokens(token), visit);
  }
}

export function inlineText(tokens: readonly Token[]): string {
  let text = "";
  for (const token of tokens) {
    const known = asMarkedToken(token);
    if (known === null) {
      text += inlineText(genericChildren(token));
      continue;
    }
    switch (known.type) {
      case "text":
        text += known.tokens === undefined ? decodeEntities(known.text) : inlineText(known.tokens);
        break;
      case "escape":
      case "codespan":
        text += known.text;
        break;
      case "br":
        text += " ";
        break;
      case "html":
        text += isLineBreakTag(known.text) ? " " : "";
        break;
      case "image":
        text += known.text;
        break;
      default:
        text += inlineText(childTokens(known));
    }
  }
  return text;
}

export interface DocHeading {
  depth: number;
  id: string;
  text: string;
}

export interface MarkdownLink {
  href: string;
  text: string;
  image: boolean;
}

export interface ParsedMarkdown {
  title: string | null;
  titleId: string | null;
  tokens: Token[];
  headings: DocHeading[];
  headingIds: ReadonlyMap<Token, string>;
  links: MarkdownLink[];
  directives: string[];
}

function headingText(heading: Tokens.Heading): string {
  return inlineText(heading.tokens).replace(/\s+/g, " ").trim();
}

function isTitle(token: Token): token is Tokens.Heading {
  const known = asMarkedToken(token);
  return known?.type === "heading" && known.depth === 1;
}

export function parseMarkdown(source: string): ParsedMarkdown {
  const all = marked.lexer(source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n"));
  const title = all.find(isTitle) ?? null;
  const slug = createSlugger();
  const headingIds = new Map<Token, string>();
  const headings: DocHeading[] = [];
  const links: MarkdownLink[] = [];
  const directives: string[] = [];
  let titleId: string | null = null;

  walkTokens(all, (token) => {
    const known = asMarkedToken(token);
    if (known === null) return;
    if (known.type === "heading") {
      const text = headingText(known);
      const id = slug(text);
      if (known === title) {
        titleId = id;
        return;
      }
      headingIds.set(known, id);
      headings.push({ depth: known.depth, id, text });
    } else if (known.type === "link" || known.type === "image") {
      links.push({
        href: known.href,
        text: inlineText(known.tokens),
        image: known.type === "image",
      });
    } else if (known.type === "html") {
      const directive = directiveName(known.text);
      if (directive !== null) directives.push(directive);
    }
  });

  return {
    title: title === null ? null : headingText(title),
    titleId,
    tokens: all.filter((token) => token !== title),
    headings,
    headingIds,
    links,
    directives,
  };
}
