import { describe, expect, it } from "vitest";

import {
  type Brief,
  briefStats,
  briefToMarkdown,
  citationIndex,
  orderedSections,
  parseBrief,
  sectionRows,
} from "./brief";

const at = "2026-11-24T10:00:00.000Z";

const brief: Brief = {
  missionId: "company-xray",
  status: "draft",
  company: {
    name: "Acme",
    url: "https://acme.com/",
    oneLiner: { text: "Acme makes payroll software.", citations: ["S1"] },
  },
  sources: [
    {
      sourceId: "S1",
      url: "https://www.acme.com/about",
      title: "About Acme",
      kind: "company_site",
      fetchedAt: at,
      quotes: ["Acme makes payroll software."],
    },
    {
      sourceId: "S2",
      url: "https://acme.com/customers",
      title: "Customers",
      kind: "company_site",
      fetchedAt: at,
      quotes: [],
    },
  ],
  sourceMix: { company_site: 2, wikipedia: 0, wikidata: 0, github: 0, feed: 0, connector: 0 },
  generatedAt: at,
  promptVersions: ["company-xray.synthesis@1"],
  sections: {
    offering: {
      status: "ok",
      claims: [
        { text: "Makes payroll software", citations: ["S1"] },
        { text: "Has a free tier", citations: ["S1"] },
      ],
    },
    customers: { status: "ok", claims: [{ text: "Sells to *banks*", citations: ["S2", "S1"] }] },
    competitors: {
      status: "ok",
      competitors: [{ name: "Globex", claim: { text: "Also payroll", citations: ["S2"] } }],
    },
    news: { status: "insufficient_evidence", note: "No dated news on the site." },
    swot: {
      status: "ok",
      strengths: [{ text: "Simple pricing", citations: ["S1"] }],
      weaknesses: [],
      opportunities: [],
      threats: [],
    },
  },
};

describe("brief", () => {
  it("parses runtime drafts and complete briefs, and rejects unsafe or uncited shapes", () => {
    expect(parseBrief(brief)).toEqual({ ok: true, brief });
    const scripted = parseBrief({
      ...brief,
      sources: [{ ...brief.sources[0], url: "javascript:alert(1)" }, brief.sources[1]],
    });
    expect(scripted.ok).toBe(false);
    const dangling = parseBrief({
      ...brief,
      sections: { offering: { status: "ok", claims: [{ text: "x", citations: ["S9"] }] } },
    });
    expect(dangling.ok).toBe(false);
    if (!dangling.ok) expect(dangling.issues.join(" ")).toMatch(/S9/);
  });

  it("orders the eight runtime sections with pending ones as null", () => {
    const sections = orderedSections(brief);
    expect(sections.map((section) => section.key)).toEqual([
      "offering",
      "customers",
      "market",
      "competitors",
      "positioning",
      "news",
      "swot",
      "techStack",
    ]);
    expect(sections.find((section) => section.key === "market")?.section).toBeNull();
    expect(sections.at(-1)?.title).toBe("Tech-stack signals");
  });

  it("flattens competitors, news and SWOT into labelled claim rows", () => {
    const rows = (key: string) =>
      sectionRows(orderedSections(brief).find((entry) => entry.key === key)?.section ?? null).map(
        (row) => [row.label, row.claim.text],
      );
    expect(rows("competitors")).toEqual([["Globex", "Also payroll"]]);
    expect(rows("swot")).toEqual([["Strength", "Simple pricing"]]);
    expect(rows("news")).toEqual([]);
  });

  it("numbers citations in reading order, one-liner first, and resolves source host", () => {
    const index = citationIndex(brief);
    expect(index.get("S1")).toMatchObject({ number: 1, host: "acme.com" });
    expect(index.get("S2")).toMatchObject({ number: 2, host: "acme.com" });
  });

  it("counts sections, gaps, claims and verified citations", () => {
    expect(briefStats(brief)).toEqual({
      sections: 5,
      insufficient: 1,
      claims: 5,
      citations: 6,
      verifiedCitations: 6,
      sources: 2,
    });
  });

  it("exports Markdown with escaped text, markers and a sources list", () => {
    const markdown = briefToMarkdown(brief, "acme.com");
    expect(markdown).toContain("Acme makes payroll software. [1]");
    expect(markdown).toContain(
      "## Offering\n\n- Makes payroll software [1]\n- Has a free tier [1]",
    );
    expect(markdown).toContain("- Sells to \\*banks\\* [2][1]");
    expect(markdown).toContain("- **Globex:** Also payroll [2]");
    expect(markdown).toContain("_Insufficient evidence._ No dated news on the site.");
    expect(markdown).toContain("1. [About Acme](https://www.acme.com/about)");
  });
});
