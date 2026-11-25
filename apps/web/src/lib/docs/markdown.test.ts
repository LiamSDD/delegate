import { describe, expect, it } from "vitest";

import {
  childTokens,
  decodeEntities,
  directiveName,
  inlineText,
  isHtmlComment,
  isLineBreakTag,
  parseMarkdown,
} from "./markdown";
import { createSlugger, slugify } from "./slug";

describe("heading slugs", () => {
  it.each([
    ["Crawler", "crawler"],
    ["PII redaction", "pii-redaction"],
    [
      "ADR 0003: Zero-cost, keyless-first model routing",
      "adr-0003-zero-cost-keyless-first-model-routing",
    ],
    ["What it does not touch, and why.", "what-it-does-not-touch-and-why"],
    [
      "Amendment 3b (2026-11-25): keep live rotation responsive",
      "amendment-3b-2026-11-25-keep-live-rotation-responsive",
    ],
    ["Ship-a-PR: Vercel Sandbox and the GitHub App", "ship-a-pr-vercel-sandbox-and-the-github-app"],
    ["1. Create a token", "1-create-a-token"],
    ["Depth · quality", "depth--quality"],
    ["Größe und Maße", "größe-und-maße"],
    ["snake_case stays", "snake_case-stays"],
  ])("slugs %j the way GitHub does", (heading, expected) => {
    expect(slugify(heading)).toBe(expected);
  });

  it("numbers repeated headings and avoids collisions with literal suffixes", () => {
    const slug = createSlugger();
    expect([slug("Limits"), slug("Limits"), slug("Limits-1"), slug("Limits")]).toEqual([
      "limits",
      "limits-1",
      "limits-1-1",
      "limits-2",
    ]);
  });
});

describe("parseMarkdown", () => {
  const parsed = parseMarkdown(
    [
      "\uFEFF# The `title` of *this*",
      "",
      "Intro with [a link](other.md#part) and <https://example.com/x>.",
      "",
      "## Setup",
      "",
      "### Setup",
      "",
      "<!-- live:redteam-summary -->",
      "",
      "<!-- a note for editors -->",
      "",
      "![diagram](images/flow.png)",
    ].join("\r\n"),
  );

  it("lifts the first level-one heading out as the title", () => {
    expect(parsed.title).toBe("The title of this");
    expect(parsed.titleId).toBe("the-title-of-this");
    expect(parsed.tokens.some((token) => token.type === "heading" && token.depth === 1)).toBe(
      false,
    );
  });

  it("gives every other heading a unique id in document order", () => {
    expect(parsed.headings).toEqual([
      { depth: 2, id: "setup", text: "Setup" },
      { depth: 3, id: "setup-1", text: "Setup" },
    ]);
    expect([...parsed.headingIds.values()]).toEqual(["setup", "setup-1"]);
  });

  it("counts the title when numbering, as GitHub does", () => {
    const repeated = parseMarkdown("# Overview\n\n## Overview\n");
    expect(repeated.titleId).toBe("overview");
    expect(repeated.headings).toEqual([{ depth: 2, id: "overview-1", text: "Overview" }]);
  });

  it("collects links, images and live directives", () => {
    expect(parsed.links).toEqual([
      { href: "other.md#part", text: "a link", image: false },
      { href: "https://example.com/x", text: "https://example.com/x", image: false },
      { href: "images/flow.png", text: "diagram", image: true },
    ]);
    expect(parsed.directives).toEqual(["redteam-summary"]);
  });

  it("has no title when the document has no level-one heading", () => {
    expect(parseMarkdown("## Only a section\n").title).toBeNull();
  });
});

describe("inline helpers", () => {
  it("decodes numeric and common named entities and leaves unknown ones alone", () => {
    expect(decodeEntities("AT&amp;T &lt;b&gt; &#169; &#x1D11E; &copy; &bogus; &")).toBe(
      "AT&T <b> © 𝄞 © &bogus; &",
    );
    expect(decodeEntities("&#0; &#xD800; &#99999999;")).toBe("&#0; &#xD800; &#99999999;");
  });

  it("flattens inline tokens to plain text without markup", () => {
    const { tokens } = parseMarkdown("A **bold** `code` [link](x.md) a<br/>b <i>tag</i> &amp;");
    expect(inlineText(tokens.flatMap(childTokens))).toBe("A bold code link a b tag &");
  });

  it("recognises line breaks, comments and directives only in their exact forms", () => {
    expect(isLineBreakTag("<br>")).toBe(true);
    expect(isLineBreakTag("<BR />")).toBe(true);
    expect(isLineBreakTag("<br onload=x>")).toBe(false);
    expect(isHtmlComment("<!-- note -->")).toBe(true);
    expect(isHtmlComment("<!-- a --><script>x</script>")).toBe(false);
    expect(directiveName("<!-- live:adr-index -->")).toBe("adr-index");
    expect(directiveName("<!-- live:adr-index --><b>")).toBeNull();
    expect(directiveName("<!-- Live:ADR -->")).toBeNull();
  });
});
