import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  XRAY_DATASET,
  XRAY_EXCLUDED_DOMAINS,
  XrayCaseSchema,
  loadXrayDataset,
  parseXrayDataset,
  selectCases,
} from "./xray";

const validCase = {
  id: "example-saas",
  mission: "xray",
  version: 1,
  input: { url: "https://example.com" },
  company: { name: "Example", country: "US", industry: "saas", size: "small" },
  expectedFacts: [
    {
      id: "founded",
      proposition: "Example was founded in 2001.",
      justification: "Stated on the about page.",
      sourceUrl: "https://example.com/about",
      verifiedAt: "2026-11-24",
    },
    {
      id: "hq",
      proposition: "Example is headquartered in Springfield.",
      justification: "Stated on Wikipedia.",
      sourceUrl: "https://en.wikipedia.org/wiki/Example",
      verifiedAt: "2026-11-24",
    },
  ],
  difficulty: "Small static site.",
  checks: [{ kind: "schema_valid" }],
  rubric: ["Accurate"],
  tags: ["saas"],
};

describe("XrayCaseSchema", () => {
  it("accepts a well-formed case", () => {
    expect(XrayCaseSchema.parse(validCase).id).toBe("example-saas");
  });

  it("requires between two and five expected facts with sources", () => {
    expect(() =>
      XrayCaseSchema.parse({ ...validCase, expectedFacts: validCase.expectedFacts.slice(0, 1) }),
    ).toThrow();
    expect(() =>
      XrayCaseSchema.parse({
        ...validCase,
        expectedFacts: [{ ...validCase.expectedFacts[0], sourceUrl: "not a url" }],
      }),
    ).toThrow();
  });

  it("requires a mission URL input", () => {
    expect(() => XrayCaseSchema.parse({ ...validCase, input: { company: "x" } })).toThrow();
  });
});

describe("parseXrayDataset", () => {
  it("rejects duplicate ids and excluded development companies", () => {
    const line = JSON.stringify(validCase);
    expect(() => parseXrayDataset(`${line}\n${line}\n`)).toThrow(/duplicate/i);
    const excluded = JSON.stringify({ ...validCase, input: { url: "https://supabase.com" } });
    expect(() => parseXrayDataset(excluded)).toThrow(/excluded/i);
  });

  it("reports the line number of an invalid case", () => {
    expect(() => parseXrayDataset(`${JSON.stringify(validCase)}\n{"id":"x"}\n`)).toThrow(/line 2/);
  });
});

describe("company-xray dataset v1", () => {
  const cases = loadXrayDataset();

  it("has at least eight cases with diverse countries, industries and sizes", () => {
    expect(cases.length).toBeGreaterThanOrEqual(8);
    expect(new Set(cases.map((c) => c.company.country)).size).toBeGreaterThanOrEqual(6);
    expect(new Set(cases.map((c) => c.company.industry)).size).toBe(cases.length);
    expect(new Set(cases.map((c) => c.company.size)).size).toBeGreaterThanOrEqual(3);
    expect(cases.every((c) => c.version === XRAY_DATASET.version)).toBe(true);
  });

  it("excludes the companies used in development runs", () => {
    expect(XRAY_EXCLUDED_DOMAINS).toContain("supabase.com");
    for (const c of cases) {
      const host = new URL(c.input.url).hostname;
      expect(XRAY_EXCLUDED_DOMAINS.some((domain) => host.endsWith(domain))).toBe(false);
    }
  });

  it("tags exactly three cases for the cheap gate", () => {
    expect(cases.filter((c) => c.tags.includes("gate"))).toHaveLength(3);
  });

  it("keeps the published JSON Schema in sync with the zod schema", () => {
    const published = JSON.parse(
      readFileSync(new URL("../../datasets/company-xray/schema.v1.json", import.meta.url), "utf8"),
    ) as unknown;
    expect(published).toEqual(z.toJSONSchema(XrayCaseSchema, { io: "input" }));
  });
});

describe("selectCases", () => {
  const cases = loadXrayDataset();

  it("returns every case by default and the requested ids in dataset order", () => {
    expect(selectCases(cases, undefined)).toEqual(cases);
    const [first, second] = cases;
    if (first === undefined || second === undefined) throw new Error("dataset too small");
    expect(selectCases(cases, [second.id, first.id]).map((c) => c.id)).toEqual([
      first.id,
      second.id,
    ]);
  });

  it("rejects unknown ids", () => {
    expect(() => selectCases(cases, ["nope"])).toThrow(/unknown case/i);
  });
});
