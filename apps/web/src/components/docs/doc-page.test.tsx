import { buildOpenApiDocument } from "@delegate/sdk/contract";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import DocsRoute, { generateMetadata, generateStaticParams } from "@/app/docs/[[...slug]]/page";
import { loadRedteamSummary } from "@/lib/docs/facts";
import { OPENAPI_PATH } from "@/lib/docs/openapi";
import { buildDocsRegistry, loadDoc } from "@/lib/docs/registry";
import { readRepoText } from "@/lib/docs/repo";
import { REPO_URL } from "@/lib/site";

import { apiReferenceState, type ApiReferenceState, ApiReferenceView } from "./api-reference";
import { DocPage } from "./doc-page";
import { DocsNav, findNavItem } from "./docs-nav";

const navigation = vi.hoisted(() => ({ pathname: "/docs" }));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ push: () => undefined }),
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  redirect: (target: string) => {
    throw new Error(`REDIRECT ${target}`);
  },
}));

const registry = buildDocsRegistry();

function props(slug?: string[]): PageProps<"/docs/[[...slug]]"> {
  return {
    params: Promise.resolve(slug === undefined ? {} : { slug }),
    searchParams: Promise.resolve({}),
  };
}

function page(slug: string[]): string {
  const entry = registry.bySlug(slug);
  if (entry === undefined) throw new Error(`No doc at ${slug.join("/")}`);
  return renderToStaticMarkup(<DocPage doc={loadDoc(entry)} registry={registry} />);
}

describe("docs page", () => {
  it("renders the security model from its Markdown with the full page frame", () => {
    const html = page(["trust", "security"]);
    expect(html).toMatch(
      /<h1 id="security-model-and-threat-model"[^>]*>Security model and threat model<\/h1>/,
    );
    expect(html).toContain("Trust</p>");
    expect(html).toContain('<h2 id="controls"');
    expect(html).toContain('<nav aria-label="On this page"');
    expect(html).toContain('href="#red-team-suite"');
    expect(html).toContain(`href="${REPO_URL}/edit/main/docs/SECURITY.md"`);
    expect(html).toContain("Edit on GitHub");
    expect(html).toContain("docs/SECURITY.md");
    expect(html).toContain('<a rel="prev"');
    expect(html).toContain('<a rel="next"');
    expect(html).toContain('href="/docs/trust/quarantined-reader"');
    expect(html).toContain('href="/docs/architecture/adr/0014-connections"');
    expect(html).not.toMatch(/arrives in|What this page will show|Available now on GitHub/);
  });

  it("renders every document without a placeholder or an unresolved directive", () => {
    for (const entry of registry.entries) {
      const html = page([...entry.slug]);
      expect(html, entry.route).toContain("<h1");
      expect(html, entry.route).toContain(`/edit/main/${entry.source}`);
      expect(html, entry.route).not.toMatch(/&lt;!--\s*live:|arrives in <|\bSTUB\b/);
    }
  });

  it("shows the red-team counts from the results file, not from the page text", () => {
    const summary = loadRedteamSummary();
    if (summary === null) throw new Error("packages/evals/results/redteam.json is missing");
    const html = page(["trust", "red-team"]);
    expect(summary.attacks).toBe(summary.byCategory.reduce((sum, row) => sum + row.attacks, 0));
    expect(html).toMatch(new RegExp(`Attack cases</dt><dd[^>]*>${String(summary.attacks)}</dd>`));
    expect(html).toMatch(
      new RegExp(`Categories</dt><dd[^>]*>${String(summary.byCategory.length)}</dd>`),
    );
    expect(html).toContain(`${(summary.asr * 100).toFixed(1)}%`);
    for (const row of summary.byCategory) expect(html).toContain(`>${row.category}</td>`);
    expect(readRepoText("docs/guides/red-team.md")).not.toContain(String(summary.attacks));
  });

  it("lists every decision record on the index page and labels a record's own page", () => {
    const index = page(["architecture", "adr"]);
    for (const adr of registry.adrs) expect(index, adr.route).toContain(`href="${adr.route}"`);
    const record = page(["architecture", "adr", "0002-quarantined-reader"]);
    expect(record).toContain("Architecture · Decision record 0002");
    expect(record).toContain("ADR 0001: Hand-written agent runtime on the Messages API");
  });

  it("renders the API page from the served document with its Markdown formatted", () => {
    const html = page(["api"]);
    expect(html).not.toContain('aria-busy="true"');
    expect(html).toContain("Delegate API");
    expect(html).toContain('<strong class="font-semibold text-text">Authentication.</strong>');
    expect(html).toMatch(/<code class="[^"]*">Authorization: Bearer dlg_…<\/code>/);
    expect(html).not.toContain("**Authentication.**");
    expect(html).not.toContain("`Authorization");
  });
});

describe("docs route", () => {
  it("enumerates every document for static params and describes each page", async () => {
    const params = generateStaticParams();
    expect(params.map((param) => param.slug.join("/"))).toEqual(
      registry.entries.map((entry) => entry.slug.join("/")),
    );
    expect(await generateMetadata(props(["quickstart"]))).toMatchObject({
      title: "Try it in two minutes · Docs",
      alternates: { canonical: "/docs/quickstart" },
    });
    expect(await generateMetadata(props())).toMatchObject({ title: "Docs" });
  });

  it("renders a document, redirects section roots and rejects unknown addresses", async () => {
    const element = await DocsRoute(props(["missions"]));
    expect(renderToStaticMarkup(element)).toContain(">Missions</h1>");
    await expect(DocsRoute(props(["trust"]))).rejects.toThrow("REDIRECT /docs/trust/security");
    await expect(DocsRoute(props(["guides"]))).rejects.toThrow("REDIRECT /docs/guides/mcp-clients");
    await expect(DocsRoute(props(["nope"]))).rejects.toThrow("NOT_FOUND");
    await expect(DocsRoute(props(["trust", "security", "extra"]))).rejects.toThrow("NOT_FOUND");
  });
});

describe("docs menu", () => {
  const sections = registry.navigation();

  it("marks the current page and keeps decision records folded away elsewhere", () => {
    navigation.pathname = "/docs/trust/red-team/";
    const html = renderToStaticMarkup(<DocsNav sections={sections} />);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(
      /aria-current="page"[^>]*href="\/docs\/trust\/red-team"|href="\/docs\/trust\/red-team"[^>]*aria-current="page"/,
    );
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(/<ul id="[^"]*" hidden=""/);
  });

  it("opens the decision records when one of them is the current page", () => {
    navigation.pathname = "/docs/architecture/adr/0007-durable-runs-from-the-event-log";
    const html = renderToStaticMarkup(<DocsNav sections={sections} />);
    expect(html).toContain('aria-expanded="true"');
    expect(html).not.toMatch(/<ul id="[^"]*" hidden=""/);
    expect(findNavItem(sections, navigation.pathname)).toMatchObject({
      section: { id: "architecture" },
      item: { prefix: "0007" },
      parent: { label: "Decision records" },
    });
    expect(findNavItem(sections, "/docs/unknown")).toBeNull();
  });
});

describe("API reference", () => {
  const view = (state: ApiReferenceState) =>
    renderToStaticMarkup(
      <ApiReferenceView state={state} registry={registry} source="docs/guides/rest-api.md" />,
    );

  it("says so honestly when the document is not OpenAPI 3", () => {
    const state = apiReferenceState({ swagger: "2.0" });
    expect(state).toEqual({
      status: "unavailable",
      detail: `The document served at ${OPENAPI_PATH} is not an OpenAPI 3 document.`,
    });
    const html = view(state);
    expect(html).toContain("The REST reference is not available on this deployment.");
    expect(html).toContain('href="/docs/guides/mcp-clients"');
    expect(apiReferenceState("<html>")).toMatchObject({ status: "unavailable" });
  });

  it("renders the document this deployment serves", () => {
    expect(apiReferenceState(buildOpenApiDocument())).toMatchObject({ status: "ready" });
  });

  it("renders operations, parameters and schemas with inline Markdown and no raw HTML", () => {
    const state = apiReferenceState({
      openapi: "3.1.0",
      info: {
        title: "Delegate API",
        version: "1.2.3",
        description: "**Errors.** Branch on `code`.\n\nInline <img src=x onerror=1> stays text.",
      },
      paths: {
        "/runs/{runId}": {
          get: {
            summary: "Get a run",
            description: "Reads _one_ run.",
            parameters: [
              {
                name: "runId",
                in: "path",
                description: "The `runId` from **POST /runs**.",
                schema: { type: "string" },
              },
            ],
            responses: {
              "404": { description: "`not_found`: no such run.\n\n`gone`: the run expired." },
              "200": {
                description: "The run, as `Run`",
                content: {
                  "application/json": { schema: { $ref: "#/components/schemas/Run" } },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: { Run: { type: "object", properties: { id: { type: "string" } } } },
      },
    });
    const html = view(state);
    expect(html).toContain("Delegate API");
    expect(html).toContain("version 1.2.3 · OpenAPI 3.1.0");
    expect(html).toContain('<article id="get-runs-runid" aria-label="GET /runs/{runId}"');
    expect(html).toContain("required");
    expect(html).toContain('<a href="#schema-run"');
    expect(html).toContain('id="schema-run"');
    expect(html).toContain('<strong class="font-semibold text-text">Errors.</strong>');
    expect(html).toMatch(/<code class="[^"]*">code<\/code>/);
    expect(html).toContain("<em>one</em>");
    expect(html).toContain('<strong class="font-semibold text-text">POST /runs</strong>');
    expect(html).toMatch(/The run, as <code class="[^"]*">Run<\/code>/);
    expect(html).not.toMatch(/<p\b[^>]*>(?:(?!<\/p>).)*<(?:p|div)\b/s);
    expect(html).toContain("&lt;img src=x onerror=1&gt;");
    expect(html).not.toContain("<img");
    expect(html).not.toMatch(/\*\*|`/);
  });
});
