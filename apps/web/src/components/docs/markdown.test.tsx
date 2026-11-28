import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { parseMarkdown } from "@/lib/docs/markdown";
import { buildDocsRegistry } from "@/lib/docs/registry";
import { REPO_URL } from "@/lib/site";

import { Markdown } from "./markdown";

const registry = buildDocsRegistry();

function render(source: string, from = "docs/guides/missions.md", directives = {}): string {
  return renderToStaticMarkup(
    <Markdown
      markdown={parseMarkdown(source)}
      source={from}
      registry={registry}
      directives={directives}
    />,
  );
}

describe("Markdown rendering: escaping", () => {
  it("shows raw HTML as text and never emits it as markup", () => {
    const html = render(
      [
        'Inline <img src=x onerror=alert(1)> and <b>bold</b> and <a href="javascript:alert(1)">x</a>.',
        "",
        "<script>alert('block')</script>",
        "",
        '<div onclick="steal()">',
        "",
        "# not a heading inside html",
        "",
        "</div>",
        "",
        "| a |",
        "|---|",
        "| <iframe src=//evil> |",
      ].join("\n"),
    );
    expect(html).not.toMatch(/<(script|img|iframe|div onclick|b>|a href="javascript)/i);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;script&gt;alert(&#x27;block&#x27;)&lt;/script&gt;");
    expect(html).toContain("&lt;iframe src=//evil&gt;");
    expect(html).toContain("HTML source");
  });

  it("escapes text, code, attributes and titles", () => {
    const html = render(
      [
        '5 < 6 & "quotes" `<code attr="x">` [t](https://example.com/?a=1&b="2" "a \\"title\\" <x>")',
        "",
        "```html",
        '<p class="x">&amp;</p>',
        "```",
      ].join("\n"),
    );
    expect(html).toContain("5 &lt; 6 &amp; &quot;quotes&quot;");
    expect(html).toContain("&lt;code attr=&quot;x&quot;&gt;");
    expect(html).toContain("&lt;p class=&quot;x&quot;&gt;&amp;amp;&lt;/p&gt;");
    expect(html).toContain('title="a &quot;title&quot; &lt;x&gt;"');
    expect(html).not.toContain('<p class="x">');
  });

  it("renders links with unsafe or malformed targets as plain text", () => {
    const html = render(
      "[a](javascript:alert(1)) [b](data:text/html,x) [c](//evil.example) [d](../../../etc/passwd) ![e](javascript:x)",
    );
    expect(html).not.toContain("<a");
    expect(html).toContain("a b c d e");
  });

  it("drops HTML comments, keeps line breaks and decodes entities", () => {
    const html = render(
      "Before <!-- hidden note --> after<br/>next &copy; &amp; &#8212;\n\n<!-- block note -->\n",
    );
    expect(html).not.toContain("hidden note");
    expect(html).not.toContain("block note");
    expect(html).toContain("after<br/>next © &amp; —");
  });
});

describe("Markdown rendering: links", () => {
  it("rewrites relative links between documents to docs routes", () => {
    const html = render(
      "[security](../SECURITY.md#crawler) [quick](quickstart.md) [adr](../adr/0002-quarantined-reader.md) [records](../adr/)",
    );
    expect(html).toContain('href="/docs/trust/security#crawler"');
    expect(html).toContain('href="/docs/quickstart"');
    expect(html).toContain('href="/docs/architecture/adr/0002-quarantined-reader"');
    expect(html).toContain('href="/docs/architecture/adr"');
    expect(html).not.toContain("_blank");
  });

  it("opens repository files and external sites in a new tab with a label", () => {
    const html = render(
      "[code](../../packages/runtime/src/router.ts) and https://example.com/page.",
    );
    expect(html).toContain(
      `<a href="${REPO_URL}/blob/main/packages/runtime/src/router.ts" target="_blank" rel="noreferrer"`,
    );
    expect(html).toContain("(opens on GitHub)");
    expect(html).toContain('<a href="https://example.com/page" target="_blank" rel="noreferrer"');
    expect(html).toContain("(opens in a new tab)");
    expect(html).toMatch(/<\/a>\.<\/p>/);
  });

  it("keeps links to the live site on the current deployment", () => {
    const html = render(
      "[c](https://trydelegate.app/settings/connections) [api](https://trydelegate.app/api/v1/openapi.json)",
    );
    expect(html).toContain('href="/settings/connections"');
    expect(html).toContain('href="/api/v1/openapi.json"');
    expect(html).not.toContain("delegate-beryl");
  });

  it("links mentions of other decision records and document paths, but not a page to itself", () => {
    const html = render(
      "See ADR 0002 and ADR 9999, and `docs/SECURITY.md`.",
      "docs/adr/0011-ship-a-pr.md",
    );
    expect(html).toContain(
      'title="Quarantined reader (dual-LLM pattern) for untrusted content" href="/docs/architecture/adr/0002-quarantined-reader">ADR 0002</a>',
    );
    expect(html).toContain("ADR 9999");
    expect(html).toContain('href="/docs/trust/security"');
    const own = render("ADR 0011 and `docs/adr/0011-ship-a-pr.md`", "docs/adr/0011-ship-a-pr.md");
    expect(own).not.toContain("<a");
  });

  it("does not nest links inside links or headings", () => {
    const html = render("## About ADR 0002\n\n[ADR 0002 and `docs/SECURITY.md`](quickstart.md)\n");
    expect(html.match(/<a /g)).toHaveLength(2);
    expect(html).toContain('href="#about-adr-0002"');
    expect(html).toContain('href="/docs/quickstart"');
  });
});

describe("Markdown rendering: structure", () => {
  it("gives headings ids, levels and a labelled anchor", () => {
    const html = render("## Setup `now`\n\n### Setup `now`\n\n# Late title\n");
    expect(html).toContain('<h2 id="setup-now"');
    expect(html).toContain('<h3 id="setup-now-1"');
    expect(html).toContain('href="#setup-now-1" aria-label="Link to the section: Setup now"');
    expect(html).not.toContain("<h1");
  });

  it("renders fenced code with a language label, a copy control and colour spans", () => {
    const html = render('```bash\nexport A="b" # note\n```\n\n```\nplain <text>\n```\n');
    expect(html).toContain("Shell");
    expect(html).toContain('<span class="text-accent">export</span>');
    expect(html).toContain('<span class="text-success">&quot;b&quot;</span>');
    expect(html).toContain('<span class="text-text-subtle"># note</span>');
    expect(html).toContain("plain &lt;text&gt;");
    expect(html.match(/<pre tabindex="0"/g)).toHaveLength(2);
    expect(html.match(/<button type="button"/g)).toHaveLength(2);
  });

  it("labels a Mermaid block as source and links to its rendering under the right heading", () => {
    const html = render(
      "## System overview\n\n```mermaid\nflowchart LR\n  A[One<br/>two] --> B\n```\n",
      "docs/ARCHITECTURE.md",
    );
    expect(html).toContain("Mermaid diagram source");
    expect(html).toContain(`href="${REPO_URL}/blob/main/docs/ARCHITECTURE.md#system-overview"`);
    expect(html).toContain("A[One&lt;br/&gt;two] --&gt; B");
  });

  it("renders tables as focusable scroll regions with header cells and alignment", () => {
    const html = render("## Limits\n\n| Name | Value |\n|:--|--:|\n| `a` | 1<br>2 |\n");
    expect(html).toContain('<div role="region" aria-label="Table: Limits" tabindex="0"');
    expect(html).toMatch(/<th scope="col" class="[^"]*text-left[^"]*">Name<\/th>/);
    expect(html).toMatch(/<th scope="col" class="[^"]*text-right[^"]*">Value<\/th>/);
    expect(html).toMatch(/<td class="[^"]*text-right[^"]*">1<br\/>2<\/td>/);
  });

  it("renders nested, ordered and task lists", () => {
    const html = render("3. three\n4. four\n   - inner\n\n- [x] done\n- [ ] open\n");
    expect(html).toContain('<ol start="3"');
    expect(html).toMatch(/<li class="pl-1">four<ul/);
    expect(html).toMatch(
      /<input type="checkbox" disabled="" readOnly="" aria-label="Done"[^>]* checked=""\/>/,
    );
    expect(html).toMatch(
      /<input type="checkbox" disabled="" readOnly="" aria-label="Not done" class="[^"]*"\/>/,
    );
  });

  it("places live directives and ignores unknown ones", () => {
    const html = render(
      "Before\n\n<!-- live:adr-index -->\n\n<!-- live:made-up -->\n\nAfter\n",
      undefined,
      {
        "adr-index": <ol data-testid="index" />,
      },
    );
    expect(html).toMatch(/Before<\/p><ol data-testid="index"><\/ol><p[^>]*>After/);
    expect(html).not.toContain("made-up");
  });
});
