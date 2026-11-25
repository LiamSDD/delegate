import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import DocsRoute, { generateMetadata, generateStaticParams } from "@/app/docs/[[...slug]]/page";
import { loadRedteamSummary } from "@/lib/docs/facts";
import { OPENAPI_PATH } from "@/lib/docs/openapi";
import { buildDocsRegistry, loadDoc } from "@/lib/docs/registry";
import { readRepoText } from "@/lib/docs/repo";
import { REPO_URL } from "@/lib/site";

import { ApiReferenceView, loadApiReference } from "./api-reference";
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

  it("starts the API page in a loading state that names the document it fetches", () => {
    const html = page(["api"]);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain(OPENAPI_PATH);
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
  const respond = (body: BodyInit | null, status: number) => () =>
    Promise.resolve(new Response(body, { status }));

  it("says so honestly when the deployment has no OpenAPI document", async () => {
    const state = await loadApiReference(respond("Not found", 404));
    expect(state).toEqual({
      status: "unavailable",
      detail: `${OPENAPI_PATH} answered 404 on this deployment.`,
    });
    const html = renderToStaticMarkup(<ApiReferenceView state={state} />);
    expect(html).toContain("The REST reference is not available on this deployment.");
    expect(html).toContain("answered 404");
    expect(html).toContain('href="/docs/guides/mcp-clients"');
  });

  it("treats network failures and non-OpenAPI answers the same way", async () => {
    expect(await loadApiReference(() => Promise.reject(new Error("offline")))).toMatchObject({
      status: "unavailable",
      detail: `The request to ${OPENAPI_PATH} did not complete.`,
    });
    expect(await loadApiReference(respond("<html>", 200))).toMatchObject({
      status: "unavailable",
      detail: `${OPENAPI_PATH} did not return JSON.`,
    });
    expect(await loadApiReference(respond('{"swagger":"2.0"}', 200))).toMatchObject({
      status: "unavailable",
      detail: `${OPENAPI_PATH} did not return an OpenAPI 3 document.`,
    });
  });

  it("renders operations, parameters and schemas from a served document as text", async () => {
    const calls: string[] = [];
    const state = await loadApiReference((input) => {
      calls.push(typeof input === "string" ? input : "not a path");
      return Promise.resolve(
        Response.json({
          openapi: "3.1.0",
          info: { title: "Delegate API", version: "1.2.3", description: "<img src=x onerror=1>" },
          paths: {
            "/runs/{runId}": {
              get: {
                summary: "Get a run",
                parameters: [{ name: "runId", in: "path", schema: { type: "string" } }],
                responses: {
                  "200": {
                    description: "The run",
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
        }),
      );
    });
    expect(calls).toEqual([OPENAPI_PATH]);
    const html = renderToStaticMarkup(<ApiReferenceView state={state} />);
    expect(html).toContain("Delegate API");
    expect(html).toContain("version 1.2.3 · OpenAPI 3.1.0");
    expect(html).toContain('<article id="get-runs-runid" aria-label="GET /runs/{runId}"');
    expect(html).toContain("required");
    expect(html).toContain('<a href="#schema-run"');
    expect(html).toContain('id="schema-run"');
    expect(html).toContain("&lt;img src=x onerror=1&gt;");
    expect(html).not.toContain("<img");
  });
});
