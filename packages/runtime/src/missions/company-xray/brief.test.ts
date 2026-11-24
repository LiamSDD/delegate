import { describe, expect, it } from "vitest";

import {
  CompanyXrayDraftOutputSchema,
  normaliseSynthesis,
  dropUnsupportedDates,
  CompanyXrayBriefSchema,
  CompanyXraySynthesisSchema,
  SECTION_KEYS,
  enforceCitations,
  type CompanyXraySynthesis,
} from "./brief";
import { CompanyXrayInputSchema } from "./input";

const claim = (text: string, citations: string[]) => ({ text, citations });
const insufficient = { status: "insufficient_evidence", note: "Not enough evidence." } as const;

function synthesis(
  overrides: Partial<CompanyXraySynthesis["sections"]> = {},
): CompanyXraySynthesis {
  return CompanyXraySynthesisSchema.parse({
    companyName: "Acme Robotics",
    oneLiner: claim("Acme builds picking robots.", ["S1"]),
    sections: {
      offering: { status: "ok", claims: [claim("Picking robots.", ["S1"])] },
      customers: insufficient,
      market: insufficient,
      competitors: {
        status: "ok",
        competitors: [{ name: "RoboCorp", claim: claim("Competes with RoboCorp.", ["S2"]) }],
      },
      positioning: insufficient,
      news: {
        status: "ok",
        items: [{ date: "2026-11-03", claim: claim("Raised a Series B.", ["S3"]) }],
      },
      swot: {
        status: "ok",
        strengths: [claim("No rails needed.", ["S2"])],
        weaknesses: [],
        opportunities: [],
        threats: [],
      },
      techStack: insufficient,
      ...overrides,
    },
  });
}

describe("CompanyXrayInputSchema", () => {
  it("accepts a homepage URL, adds https to bare domains and trims focus", () => {
    expect(CompanyXrayInputSchema.parse({ url: "acme.example", focus: "  pricing " })).toEqual({
      url: "https://acme.example/",
      focus: "pricing",
    });
    expect(CompanyXrayInputSchema.parse({ url: "http://www.acme.example/en" })).toEqual({
      url: "http://www.acme.example/en",
    });
  });

  it.each([
    { url: "" },
    { url: "ftp://acme.example" },
    { url: "javascript:alert(1)" },
    { url: "https://user:pw@acme.example" }, // secret-scan: allow url-credentials
    {},
    { url: "https://acme.example", focus: "x".repeat(501) },
  ])("rejects %j", (input) => {
    expect(CompanyXrayInputSchema.safeParse(input).success).toBe(false);
  });
});

describe("CompanyXraySynthesisSchema", () => {
  it("requires at least one citation per claim", () => {
    expect(() =>
      synthesis({ offering: { status: "ok", claims: [claim("Uncited.", [])] } }),
    ).toThrow();
  });

  it("caps competitors at five", () => {
    const competitors = Array.from({ length: 6 }, (_, index) => ({
      name: `C${index}`,
      claim: claim("x", ["S1"]),
    }));
    expect(() => synthesis({ competitors: { status: "ok", competitors } })).toThrow();
  });

  it("tolerates common citation formatting from small models", () => {
    const parsed = CompanyXraySynthesisSchema.parse({
      companyName: "Acme",
      oneLiner: { text: "x", citations: "[S1], S2" },
      sections: Object.fromEntries(SECTION_KEYS.map((key) => [key, insufficient])),
    });
    expect(parsed.oneLiner?.citations).toEqual(["S1", "S2"]);
  });
});

describe("enforceCitations", () => {
  it("drops citations to unknown sources, then claims left without any, and downgrades emptied sections", () => {
    const result = enforceCitations(
      synthesis({
        offering: {
          status: "ok",
          claims: [claim("Kept.", ["S1", "S9"]), claim("Dropped.", ["S9"])],
        },
        positioning: { status: "ok", claims: [claim("Only invented.", ["S42"])] },
      }),
      new Set(["S1", "S2", "S3"]),
    );
    expect(result.sections.offering).toEqual({ status: "ok", claims: [claim("Kept.", ["S1"])] });
    expect(result.sections.positioning).toMatchObject({ status: "insufficient_evidence" });
    expect(result.dropped.map((entry) => entry.text)).toEqual(["Dropped.", "Only invented."]);
  });

  it("produces a brief that passes the citation-integrity refinement", () => {
    const result = enforceCitations(synthesis(), new Set(["S1", "S2", "S3"]));
    const sources = ["S1", "S2", "S3"].map((sourceId) => ({
      sourceId,
      url: `https://acme.example/${sourceId}`,
      title: sourceId,
      kind: "company_site" as const,
      fetchedAt: "2026-11-24T10:00:00.000Z",
      quotes: ["a quote"],
    }));
    const brief = {
      missionId: "company-xray",
      status: "complete",
      company: { name: "Acme Robotics", url: "https://acme.example/", oneLiner: result.oneLiner },
      sections: result.sections,
      sources,
      sourceMix: { company_site: 3, wikipedia: 0, wikidata: 0, github: 0, feed: 0 },
      generatedAt: "2026-11-24T10:01:00.000Z",
      promptVersions: ["company-xray.synthesis@1"],
    };
    expect(CompanyXrayBriefSchema.safeParse(brief).success).toBe(true);
    expect(
      CompanyXrayBriefSchema.safeParse({ ...brief, sources: sources.slice(0, 2) }).success,
    ).toBe(false);
  });
});

describe("normaliseSynthesis", () => {
  const raw = (sections: Record<string, unknown>) =>
    CompanyXrayDraftOutputSchema.parse({
      companyName: "Acme",
      oneLiner: { text: "Acme builds robots.", citations: ["S1"] },
      sections,
    });

  it("keeps valid claims, drops invalid ones and salvages string claims with inline ids", () => {
    const result = normaliseSynthesis(
      raw({
        offering: {
          status: "ok",
          claims: [
            { text: "Robots.", citations: ["S1"] },
            { text: "No citation." },
            "Fleet software [S2]",
            42,
          ],
        },
        swot: {
          status: "ok",
          strengths: ["Strong brand"],
          weaknesses: [{ text: "Small team.", citations: ["S3"] }],
        },
        competitors: {
          status: "ok",
          competitors: Array.from({ length: 7 }, (_, index) => ({
            name: `C${index}`,
            claim: { text: "x", citations: ["S1"] },
          })),
        },
      }),
    );
    expect(result.synthesis.sections.offering).toEqual({
      status: "ok",
      claims: [
        { text: "Robots.", citations: ["S1"] },
        { text: "Fleet software", citations: ["S2"] },
      ],
    });
    expect(result.synthesis.sections.swot).toMatchObject({
      status: "ok",
      strengths: [],
      weaknesses: [{ text: "Small team." }],
    });
    expect(
      result.synthesis.sections.competitors.status === "ok" &&
        result.synthesis.sections.competitors.competitors,
    ).toHaveLength(5);
    expect(result.discarded).toBe(3);
  });

  it("turns missing or malformed sections into insufficient evidence instead of failing", () => {
    const result = normaliseSynthesis(
      raw({ offering: "lots of stuff", news: { status: "ok", items: [] } }),
    );
    expect(result.synthesis.sections.offering).toMatchObject({ status: "insufficient_evidence" });
    expect(result.synthesis.sections.news).toMatchObject({ status: "insufficient_evidence" });
    expect(result.synthesis.sections.market).toMatchObject({ status: "insufficient_evidence" });
    expect(result.malformed).toEqual(expect.arrayContaining(["offering", "news", "market"]));
  });

  it("keeps a model-declared insufficient_evidence section and its note", () => {
    const result = normaliseSynthesis(
      raw({ market: { status: "insufficient_evidence", note: "No sizing." } }),
    );
    expect(result.synthesis.sections.market).toEqual({
      status: "insufficient_evidence",
      note: "No sizing.",
    });
    expect(result.malformed).not.toContain("market");
  });

  it("requires the top-level shape so the repair attempt can fix it", () => {
    expect(CompanyXrayDraftOutputSchema.safeParse({ sections: {} }).success).toBe(false);
    expect(CompanyXrayDraftOutputSchema.safeParse({ companyName: "A", sections: [] }).success).toBe(
      false,
    );
  });
});

describe("dropUnsupportedDates", () => {
  it("keeps a news date only when the cited evidence contains it", () => {
    const sections = synthesis({
      news: {
        status: "ok",
        items: [
          { date: "2026-11-03", claim: claim("Raised a Series B.", ["S3"]) },
          { date: "2025-04-01", claim: claim("Launched v2.", ["S2"]) },
          { date: "March 2024", claim: claim("Opened Austin office.", ["S2"]) },
        ],
      },
    }).sections;
    const evidence = new Map([
      ["S3", "Recent feed items: - 2026-11-03: Acme raises Series B"],
      ["S2", "Acme launched v2 in spring. Opened Austin office in March 2024."],
    ]);
    const result = dropUnsupportedDates(sections, evidence);
    expect(result.sections.news).toEqual({
      status: "ok",
      items: [
        { date: "2026-11-03", claim: claim("Raised a Series B.", ["S3"]) },
        { claim: claim("Launched v2.", ["S2"]) },
        { date: "March 2024", claim: claim("Opened Austin office.", ["S2"]) },
      ],
    });
    expect(result.dropped).toBe(1);
  });
});
