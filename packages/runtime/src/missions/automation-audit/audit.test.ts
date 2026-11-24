import { describe, expect, it } from "vitest";

import { checkSpecificity, matchGeneric, specificTerms } from "./genericity";
import { lensesFor } from "./lenses";
import { AUDIT_FORMULA, estimateRoi } from "./roi";
import { AutomationAuditSchema, type Opportunity } from "./schema";

const base = {
  frequencyPerMonth: 40,
  minutesPerTask: 30,
  peopleInvolved: 3,
  adoptionRate: 0.5,
  hourlyCostEur: 50,
};

describe("estimateRoi", () => {
  it("applies the published formula", () => {
    expect(estimateRoi(base)).toEqual({ inputs: base, hoursPerMonth: 30, eurPerMonth: 1500 });
  });

  it("applies slider overrides without mutating the opportunity", () => {
    const opportunity = { ...base };
    expect(estimateRoi(opportunity, { adoptionRate: 0.25, hourlyCostEur: 40 })).toMatchObject({
      hoursPerMonth: 15,
      eurPerMonth: 600,
    });
    expect(opportunity).toEqual(base);
  });

  it("clamps nonsense inputs instead of producing negative or infinite money", () => {
    expect(
      estimateRoi(base, { frequencyPerMonth: -5, adoptionRate: 3, minutesPerTask: Number.NaN }),
    ).toMatchObject({ hoursPerMonth: 0, eurPerMonth: 0, inputs: { adoptionRate: 1 } });
    expect(estimateRoi({ ...base, minutesPerTask: 7 })).toMatchObject({
      hoursPerMonth: 7,
      eurPerMonth: 350,
    });
  });
});

describe("genericity guard", () => {
  const quotes = new Map([
    ["S1", ["Acme Freight ships pallets for 1,400 Shopify merchants across 9 EU countries."]],
    ["S2", ["We're hiring 6 Customer Care Specialists (German, Dutch) for our Zendesk queue."]],
  ]);
  const context = { companyName: "Acme Freight", quotes };

  it("matches the generic phrase list", () => {
    expect(matchGeneric("Use AI for customer support")).toBe("use AI for customer support");
    expect(matchGeneric("A website chatbot for FAQs")).toBe("chatbot for FAQs");
    expect(matchGeneric("Draft carrier claims from damage photos")).toBeUndefined();
  });

  it("rejects a generic workflow without cited specifics and one without company evidence", () => {
    const generic = checkSpecificity(
      {
        title: "Use AI for customer support",
        workflow: "Use AI for customer support to answer common questions.",
        automation: "A chatbot answers questions.",
        evidence: [{ text: "Acme has customers.", citations: ["S1"] }],
      },
      context,
    );
    expect(generic).toMatchObject({
      ok: false,
      reasons: [expect.stringMatching(/generic/) as unknown],
    });
    const uncited = checkSpecificity(
      {
        title: "Carrier claims",
        workflow: "Ops staff draft damage claims to carriers by hand.",
        automation: "Draft claims.",
        evidence: [{ text: "Unknown.", citations: ["S9"] }],
      },
      context,
    );
    expect(uncited).toMatchObject({ ok: false, reasons: ["cites no evidence about this company"] });
  });

  it("accepts a generic-sounding workflow that is tied to cited specifics", () => {
    expect(
      checkSpecificity(
        {
          title: "Use AI for customer support",
          workflow:
            "Use AI for customer support in the Zendesk queue: the 6 German and Dutch Customer Care Specialists triage Shopify merchant tickets by hand.",
          automation: "Pre-sort tickets by carrier and language.",
          evidence: [
            { text: "Hiring 6 Customer Care Specialists for Zendesk.", citations: ["S2"] },
          ],
        },
        context,
      ),
    ).toEqual({ ok: true });
    expect(specificTerms(quotes.get("S1") ?? [], "Acme Freight").has("acme")).toBe(false);
  });
});

describe("lensesFor", () => {
  it("narrows to the requested department and falls back to all lenses", () => {
    expect(lensesFor("Finance").map((lens) => lens.id)).toEqual(["finance"]);
    expect(lensesFor("Customer Success").map((lens) => lens.id)).toEqual(["sales"]);
    expect(lensesFor(undefined)).toHaveLength(4);
    expect(lensesFor("Underwater basket weaving")).toHaveLength(4);
  });
});

describe("AutomationAuditSchema", () => {
  const opportunity = (id: string, frequencyPerMonth: number): Opportunity => ({
    id,
    title: `Opportunity ${id}`,
    department: "Operations",
    workflow: "Ops staff copy Shopify orders into the carrier portal.",
    automation: "An agent books the carrier slot.",
    ...base,
    frequencyPerMonth,
    difficulty: "medium",
    risks: ["Wrong booking"],
    integrations: ["Shopify"],
    firstStep: "Export one week of orders.",
    evidence: [{ text: "1,400 Shopify merchants.", citations: ["S1"] }],
    assumptions: ["Each person books 40 slots a month."],
  });
  const audit = (opportunities: Opportunity[]) => ({
    company: "Acme Freight",
    summary: "Two opportunities.",
    opportunities,
    sources: [
      {
        sourceId: "S1",
        url: "https://acme.example/",
        title: "Acme",
        fetchedAt: "2026-11-24T10:00:00.000Z",
        kind: "company_site",
      },
    ],
    formula: AUDIT_FORMULA,
  });

  it("accepts a ranked, cited audit", () => {
    expect(
      AutomationAuditSchema.safeParse(audit([opportunity("a", 80), opportunity("b", 40)])).success,
    ).toBe(true);
  });

  it("rejects unranked audits, unknown citations and duplicate ids", () => {
    const messages = (value: unknown) =>
      AutomationAuditSchema.safeParse(value).error?.issues.map((issue) => issue.message) ?? [];
    expect(messages(audit([opportunity("a", 40), opportunity("b", 80)]))).toContain(
      "Opportunities must be ranked by estimated €/month",
    );
    expect(
      messages(audit([{ ...opportunity("a", 40), evidence: [{ text: "x", citations: ["S7"] }] }])),
    ).toContain("Citation S7 does not match any source");
    expect(messages(audit([opportunity("a", 40), opportunity("a", 40)]))).toContain(
      "Duplicate opportunity id a",
    );
  });
});

describe("normaliseCandidate", () => {
  it("caps per-person time at half an FTE and states it as an assumption", async () => {
    const { normaliseCandidate } = await import("./run");
    const { AUDIT_LENSES } = await import("./lenses");
    const lens = AUDIT_LENSES[0];
    if (lens === undefined) throw new Error("no lens");
    const candidate = normaliseCandidate(
      {
        title: "Reviews",
        workflow: "Review merchant applications.",
        automation: "Pre-check them.",
        frequencyPerMonth: 2000,
        minutesPerTask: 20,
        peopleInvolved: 8,
        adoptionRate: 0.4,
        hourlyCostEur: 55,
        difficulty: "medium",
        risks: [],
        integrations: [],
        firstStep: "Start.",
        evidence: [{ text: "x", citations: ["S1"] }],
        assumptions: [],
      },
      lens,
      new Set(["S1"]),
      "c1",
      "Support",
    );
    expect(candidate.department).toBe("Support");
    expect((candidate.frequencyPerMonth * candidate.minutesPerTask) / 60).toBeLessThanOrEqual(80);
    expect(candidate.assumptions.join(" ")).toMatch(/half a full-time/);
  });
});

describe("pickCompanyName", () => {
  it("prefers the discovered name that the evidence mentions most", async () => {
    const { pickCompanyName } = await import("./run");
    expect(
      pickCompanyName(
        ["Online Payment Processing Solution", "GoCardless"],
        ["GoCardless collects", "Use GoCardless"],
        "gocardless.com",
      ),
    ).toBe("GoCardless");
    expect(pickCompanyName([], [], "acme.example")).toBe("acme.example");
  });
});
