import { describe, expect, it } from "vitest";

import { GET } from "@/app/docs/search-index.json/route";

import { buildDocsRegistry } from "./registry";
import { normaliseSearchText, type SearchEntry, searchDocs } from "./search";
import { buildSearchIndex } from "./search-index";

const registry = buildDocsRegistry();
const index = buildSearchIndex(registry);

function top(query: string): string | undefined {
  return searchDocs(index, query)[0]?.href;
}

describe("search index", () => {
  it("has one entry per document with its headings", () => {
    expect(index.map((entry) => entry.route)).toEqual(registry.entries.map((entry) => entry.route));
    const security = index.find((entry) => entry.route === "/docs/trust/security");
    expect(security?.section).toBe("Trust");
    expect(security?.headings).toContainEqual({ id: "crawler", text: "Crawler" });
    expect(index.find((entry) => entry.route.endsWith("/0002-quarantined-reader"))?.title).toMatch(
      /^ADR 0002: /,
    );
  });

  it("stays small enough to fetch on demand", () => {
    expect(JSON.stringify(index).length).toBeLessThan(60_000);
  });

  it("is served as JSON by the static route", async () => {
    const response = GET();
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual(index);
  });
});

describe("searchDocs", () => {
  it("finds pages by title, summary and heading", () => {
    expect(top("quarantined reader")).toBe("/docs/trust/quarantined-reader");
    expect(top("red team")).toBe("/docs/trust/red-team");
    expect(top("retention")).toBe("/docs/trust/privacy-and-retention");
    expect(top("pglite")).toBe("/docs/guides/run-locally");
    expect(top("crawler")).toBe("/docs/trust/security#crawler");
    expect(top("autopilot")).toMatch(/autopilot/);
    expect(top("fork")).toMatch(/fork/);
  });

  it("matches prefixes, ignores case and accents, and needs every term", () => {
    expect(top("QUARANT")).toBe("/docs/trust/quarantined-reader");
    expect(normaliseSearchText("  Größe–Maße, Ship-a-PR! ")).toBe("große maße ship a pr");
    expect(searchDocs(index, "quarantined zebra")).toEqual([]);
    expect(searchDocs(index, "   ")).toEqual([]);
  });

  it("ranks a page above its own sections and respects the limit", () => {
    const entries: SearchEntry[] = [
      {
        route: "/docs/a",
        title: "Policy and approvals",
        section: "Trust",
        summary: "What is checked",
        headings: [
          { id: "approvals", text: "Approvals" },
          { id: "audit", text: "Audit" },
        ],
      },
      {
        route: "/docs/b",
        title: "Missions",
        section: "Start here",
        summary: "Plan approvals are described elsewhere",
        headings: [],
      },
    ];
    expect(searchDocs(entries, "approvals").map((hit) => hit.href)).toEqual([
      "/docs/a",
      "/docs/a#approvals",
      "/docs/b",
    ]);
    expect(searchDocs(entries, "approvals", 1)).toHaveLength(1);
    expect(searchDocs(entries, "policy audit").map((hit) => hit.href)).toEqual(["/docs/a#audit"]);
  });
});
