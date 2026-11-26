export const PHONE_WIDTH_REM = 20;
export const PAGE_GUTTER_REM = 2;
export const LONG_TOKEN = 24;

const ROOM_REM = PHONE_WIDTH_REM - PAGE_GUTTER_REM;

const VOID_ELEMENTS = new Set(["input", "br", "hr", "img", "meta", "link", "source", "wbr"]);
const SCROLLS = ["overflow-auto", "overflow-x-auto"];
const CONTAINS = [...SCROLLS, "overflow-hidden", "truncate", "sr-only"];
const SKIPPED_TEXT = new Set(["option", "title", "script", "style"]);

interface Node {
  tag: string;
  classes: Set<string>;
}

function has(node: Node, names: readonly string[]): boolean {
  return names.some((name) => node.classes.has(name));
}

function decode(text: string): string {
  return text
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function isRowFlex(node: Node): boolean {
  return (
    (node.classes.has("flex") || node.classes.has("inline-flex")) && !node.classes.has("flex-col")
  );
}

function isLooseGrid(node: Node): boolean {
  if (!node.classes.has("grid")) return false;
  return ![...node.classes].some((name) => /^grid-cols-(\d+|\[.*minmax\(0,.*\])$/.test(name));
}

function remOf(value: string, unit: string): number {
  return unit === "px" ? Number(value) / 16 : Number(value);
}

function fixedWidthRem(name: string): number | null {
  const scale = /^(?:min-w|w|size|basis)-(\d+(?:\.\d+)?)$/.exec(name);
  if (scale?.[1] !== undefined) return Number(scale[1]) / 4;
  const arbitrary = /^(?:min-w|w|size|basis)-\[(\d+(?:\.\d+)?)(rem|px)\]$/.exec(name);
  if (arbitrary?.[1] !== undefined && arbitrary[2] !== undefined)
    return remOf(arbitrary[1], arbitrary[2]);
  const tracks = /^grid-cols-\[(.+)\]$/.exec(name);
  if (tracks?.[1] !== undefined)
    return [...tracks[1].matchAll(/(?<![(\d.])(\d+(?:\.\d+)?)(rem|px)/g)].reduce(
      (sum, match) => sum + remOf(match[1] ?? "0", match[2] ?? "rem"),
      0,
    );
  return null;
}

export function phoneWidthProblems(html: string): string[] {
  const problems: string[] = [];
  const stack: Node[] = [];
  const pattern = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s[^<>]*)?)>|([^<]+)/g;

  const contained = () => stack.some((node) => has(node, CONTAINS));
  const scrollable = () => stack.some((node) => has(node, SCROLLS));

  const checkElement = (node: Node) => {
    if (node.tag === "pre" && !has(node, SCROLLS))
      problems.push("<pre> without overflow-auto would push the page wider than the phone");
    if (node.tag === "table" && !scrollable())
      problems.push("<table> outside a horizontally scrollable wrapper");
    for (const name of node.classes) {
      if ((name === "w-max" || name === "min-w-max" || name === "w-screen") && !scrollable())
        problems.push(`${name} outside a horizontally scrollable wrapper`);
      const width = fixedWidthRem(name);
      if (width !== null && width > ROOM_REM && !scrollable())
        problems.push(`${name} is ${String(width)}rem, wider than a ${String(ROOM_REM)}rem phone`);
    }
  };

  const checkText = (raw: string) => {
    const leaf = stack.at(-1);
    if (leaf === undefined || SKIPPED_TEXT.has(leaf.tag)) return;
    const token = decode(raw)
      .split(/\s+/)
      .find((word) => word.length >= LONG_TOKEN);
    if (token === undefined || contained()) return;
    const label = `"${token.slice(0, 40)}"`;
    const breaker = [...stack].reverse().find((node) => has(node, ["break-all", "break-words"]));
    if (breaker === undefined) {
      problems.push(`${label} has no break-all, break-words or scroll container around it`);
      return;
    }
    if (breaker.classes.has("break-all")) return;
    for (let index = stack.length - 1; index > 0; index -= 1) {
      const node = stack[index];
      const parent = stack[index - 1];
      if (node === undefined || parent === undefined) continue;
      if (has(node, ["min-w-0", ...CONTAINS])) continue;
      if (isRowFlex(parent) || isLooseGrid(parent))
        problems.push(
          `${label} wraps with break-words, but <${node.tag} class="${[...node.classes].join(" ")}"> is a flex or grid item without min-w-0`,
        );
    }
  };

  for (const match of html.replace(/<!--.*?-->/gs, "").matchAll(pattern)) {
    const [, closing, tag, attributes, text] = match;
    if (text !== undefined) {
      checkText(text);
      continue;
    }
    if (tag === undefined) continue;
    const name = tag.toLowerCase();
    if (closing === "/") {
      while (stack.length > 0 && stack.pop()?.tag !== name);
      continue;
    }
    const classes = new Set((/\sclass="([^"]*)"/.exec(attributes ?? "")?.[1] ?? "").split(/\s+/));
    const node: Node = { tag: name, classes };
    checkElement(node);
    if (!VOID_ELEMENTS.has(name) && !(attributes ?? "").endsWith("/")) stack.push(node);
  }
  return [...new Set(problems)];
}
