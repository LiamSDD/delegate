import { describe, expect, it } from "vitest";

import nextConfig from "../../../next.config";

import { checkDocs } from "./check";
import {
  ADR_DIRECTORY,
  DOC_MANIFEST,
  DOC_SECTIONS,
  GUIDES_DIRECTORY,
  SECTION_REDIRECTS,
} from "./manifest";
import { parseMarkdown } from "./markdown";
import {
  buildDocsRegistry,
  type DocEntry,
  docRoute,
  loadDoc,
  type NavItem,
  parseAdrMeta,
  registryOf,
} from "./registry";
import { listRepoDir, repoFileExists } from "./repo";

const registry = buildDocsRegistry();

function flatten(items: readonly NavItem[]): NavItem[] {
  return items.flatMap((item) => [item, ...flatten(item.children ?? [])]);
}

function entry(source: string, slug: string[], overrides: Partial<DocEntry> = {}): DocEntry {
  return {
    slug,
    route: docRoute(slug),
    source,
    section: "guides",
    label: source,
    summary: "",
    adr: null,
    ...overrides,
  };
}

describe("docs registry", () => {
  it("includes every decision record in docs/adr, in order", () => {
    const files = listRepoDir(ADR_DIRECTORY).filter((file) => /^\d{4}-.*\.md$/.test(file));
    expect(files.length).toBeGreaterThanOrEqual(16);
    expect(registry.adrs.map((adr) => adr.source)).toEqual(
      files.map((file) => `${ADR_DIRECTORY}/${file}`),
    );
    expect(registry.adrByNumber("0002")?.route).toBe(
      "/docs/architecture/adr/0002-quarantined-reader",
    );
    expect(registry.adrByNumber("0002")?.adr).toMatchObject({
      number: "0002",
      status: "Accepted",
      date: "2026-11-24",
    });
  });

  it("serves every guide file and every required source document", () => {
    const sources = new Set(registry.entries.map((item) => item.source));
    const guides = listRepoDir(GUIDES_DIRECTORY).filter((file) => file.endsWith(".md"));
    expect(guides.length).toBeGreaterThan(0);
    for (const file of guides) expect(sources, file).toContain(`${GUIDES_DIRECTORY}/${file}`);
    for (const required of [
      "docs/ARCHITECTURE.md",
      "docs/SECURITY.md",
      "docs/DEPLOY.md",
      "docs/CASE_STUDY.md",
      "packages/evals/datasets/README.md",
      "packages/db/README.md",
    ])
      expect(sources, required).toContain(required);
  });

  it("gives every document a unique route and a place in the menu", () => {
    const routes = registry.entries.map((item) => item.route);
    expect(new Set(routes).size).toBe(routes.length);
    const menu = new Set(
      registry.navigation().flatMap((section) => flatten(section.items).map((item) => item.route)),
    );
    for (const route of routes) expect(menu, route).toContain(route);
    expect(menu.size).toBe(routes.length);
    expect(registry.navigation().map((section) => section.id)).toEqual(
      DOC_SECTIONS.map((section) => section.id),
    );
    for (const section of registry.navigation()) expect(section.items.length).toBeGreaterThan(0);
  });

  it("chains previous and next through every document exactly once", () => {
    const seen: string[] = [];
    let current = registry.bySlug([]) ?? null;
    expect(current === null ? null : registry.neighbours(current).previous).toBeNull();
    while (current !== null) {
      seen.push(current.route);
      const next: DocEntry | null = registry.neighbours(current).next;
      if (next !== null) expect(registry.neighbours(next).previous).toBe(current);
      current = next;
    }
    expect(seen).toEqual(registry.entries.map((item) => item.route));
  });

  it("resolves every route back to its document and redirects section roots to real pages", () => {
    for (const item of registry.entries) expect(registry.bySlug(item.slug)).toBe(item);
    expect(registry.bySlug(["nope"])).toBeUndefined();
    for (const [section, target] of Object.entries(SECTION_REDIRECTS)) {
      expect(registry.bySlug([section]), section).toBeUndefined();
      expect(registry.bySlug(target), section).toBeDefined();
    }
  });

  it("gives every document a title from its own first heading", () => {
    for (const item of registry.entries) {
      const doc = loadDoc(item);
      expect(doc.markdown.title, item.source).not.toBeNull();
      expect(doc.title.length, item.source).toBeGreaterThan(2);
    }
  });

  it("keeps the manifest free of placeholders", () => {
    for (const item of DOC_MANIFEST) {
      expect(item.summary.length, item.source).toBeGreaterThan(20);
      const text = JSON.stringify(
        loadDoc({ ...item, route: docRoute(item.slug), adr: null }).markdown.tokens,
      );
      expect(text, item.source).not.toMatch(/\bSTUB\b|\bTODO\b|lorem ipsum|coming soon/i);
    }
  });

  it("reads status and date from a decision record's header", () => {
    expect(
      parseAdrMeta(
        "0042",
        "# ADR 0042: A choice\n\n- Status: Accepted (amended)\n- Date: 2026-01-02\n",
      ),
    ).toEqual({
      number: "0042",
      title: "A choice",
      status: "Accepted (amended)",
      date: "2026-01-02",
    });
    expect(parseAdrMeta("0043", "No heading here")).toEqual({
      number: "0043",
      title: "ADR 0043",
      status: null,
      date: null,
    });
  });
});

describe("internal links", () => {
  it("has no broken link, anchor, repository path, app route or directive in any document", () => {
    expect(checkDocs(registry)).toEqual([]);
  });

  it("reports each kind of broken reference", () => {
    const pages: Record<string, string> = {
      "docs/guides/a.md": [
        "# A",
        "",
        "## Real section",
        "",
        "[ok](b.md#target) [same page](#real-section)",
        "[missing anchor](b.md#nope) [missing here](#gone)",
        "[missing file](../../packages/nowhere.ts) [escape](../../../x.md)",
        "[script](javascript:alert(1))",
        "[app](https://delegate-beryl.vercel.app/evals) [no app](https://delegate-beryl.vercel.app/not-a-page)",
        "[docs](https://delegate-beryl.vercel.app/docs/b) [no docs](https://delegate-beryl.vercel.app/docs/zzz)",
        "",
        "<!-- live:not-a-directive -->",
      ].join("\n"),
      "docs/guides/b.md": "## No title\n\n### Target\n",
    };
    const fake = registryOf([
      entry("docs/guides/a.md", ["a"]),
      entry("docs/guides/b.md", ["b"]),
      entry("docs/guides/c.md", ["b"]),
    ]);
    const problems = checkDocs(
      fake,
      (item) => {
        const markdown = parseMarkdown(pages[item.source] ?? "");
        return { entry: item, title: markdown.title ?? item.label, markdown };
      },
      (repoPath) => repoPath in pages || repoFileExists(repoPath),
    );
    expect(
      problems.map((problem) => `${problem.source} ${problem.subject}: ${problem.reason}`),
    ).toEqual([
      "docs/guides/a.md not-a-directive: unknown live directive",
      "docs/guides/a.md b.md#nope: no heading with this anchor in docs/guides/b.md",
      "docs/guides/a.md #gone: no heading with this anchor on the page",
      "docs/guides/a.md ../../packages/nowhere.ts: packages/nowhere.ts does not exist in the repository",
      "docs/guides/a.md ../../../x.md: path leaves the repository",
      "docs/guides/a.md javascript:alert(1): scheme javascript: is not allowed",
      "docs/guides/a.md https://delegate-beryl.vercel.app/not-a-page: /not-a-page is not a page of the app",
      "docs/guides/a.md https://delegate-beryl.vercel.app/docs/zzz: /docs/zzz is not a page of the app",
      "docs/guides/b.md title: no level-one heading",
      "docs/guides/c.md /docs/b: route also used by docs/guides/b.md",
      "docs/guides/c.md docs/guides/c.md: source file is missing",
    ]);
  });
});

describe("deployment", () => {
  function matches(pattern: string, repoPath: string): boolean {
    const relative = pattern.replace(/^\.\.\/\.\.\//, "");
    const expression = relative
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]*");
    return new RegExp(`^${expression}$`).test(repoPath);
  }

  it("traces every file the docs read at request time into the server bundle", () => {
    const patterns = nextConfig.outputFileTracingIncludes?.["/docs/**"] ?? [];
    expect(patterns.length).toBeGreaterThan(0);
    for (const pattern of patterns) expect(pattern.startsWith("../../"), pattern).toBe(true);
    const needed = [
      ...registry.entries.map((item) => item.source),
      "packages/evals/results/redteam.json",
    ];
    for (const file of needed)
      expect(
        patterns.some((pattern) => matches(pattern, file)),
        `${file} is not covered by outputFileTracingIncludes["/docs/**"]`,
      ).toBe(true);
  });
});
