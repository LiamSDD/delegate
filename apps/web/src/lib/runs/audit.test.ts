import { describe, expect, it } from "vitest";

import { AUDIT_FORMULA, type AutomationAudit, type Opportunity } from "@/lib/m2-contract";

import {
  auditToCsv,
  auditToMarkdown,
  formulaWithValues,
  parseAudit,
  portfolioTotal,
  rankedOpportunities,
} from "./audit";

function opportunity(id: string, overrides: Partial<Opportunity> = {}): Opportunity {
  return {
    id,
    title: `Opportunity ${id}`,
    department: "Support",
    workflow: "Agents triage tickets by hand",
    automation: "An agent drafts the triage",
    frequencyPerMonth: 100,
    minutesPerTask: 6,
    peopleInvolved: 2,
    adoptionRate: 0.5,
    hourlyCostEur: 40,
    difficulty: "low",
    risks: ["Wrong routing"],
    integrations: ["Zendesk"],
    firstStep: "Export 50 tickets",
    evidence: [{ text: "They run a help centre", citations: ["S1"] }],
    assumptions: ["Two agents on triage"],
    ...overrides,
  };
}

const audit: AutomationAudit = {
  company: "Acme",
  summary: "Acme runs support and sales in-house.",
  opportunities: [
    opportunity("b", { frequencyPerMonth: 400, title: "Big, one" }),
    opportunity("a"),
  ],
  sources: [
    {
      sourceId: "S1",
      url: "https://acme.test/help",
      title: "Help",
      kind: "company_site",
      fetchedAt: "2026-11-24T10:00:00.000Z",
    },
  ],
  formula: AUDIT_FORMULA,
};

describe("audit ROI binding", () => {
  it("ranks by € per month using slider overrides", () => {
    expect(rankedOpportunities(audit, {}).map((entry) => entry.opportunity.id)).toEqual(["b", "a"]);
    const ranked = rankedOpportunities(audit, { a: { peopleInvolved: 20 } });
    expect(ranked.map((entry) => entry.opportunity.id)).toEqual(["a", "b"]);
    expect(ranked[0]?.estimate.hoursPerMonth).toBe(100);
  });

  it("sums the portfolio from the current overrides", () => {
    expect(portfolioTotal(audit, {})).toEqual({ hoursPerMonth: 50, eurPerMonth: 2000 });
    expect(portfolioTotal(audit, { a: { adoptionRate: 1 } })).toEqual({
      hoursPerMonth: 60,
      eurPerMonth: 2400,
    });
  });

  it("shows the formula with the current values substituted", () => {
    expect(formulaWithValues(opportunity("a"), { minutesPerTask: 9 })).toBe(
      "100/mo × 9 min × 2 people × 50% ÷ 60 = 15 h/mo × €40/h = €600/mo",
    );
  });

  it("exports one CSV row per opportunity with slider values, quoting commas", () => {
    const csv = auditToCsv(audit, { b: { hourlyCostEur: 50 } }).split("\n");
    expect(csv[0]).toContain("frequency_per_month");
    expect(csv).toHaveLength(3);
    expect(csv[1]).toContain('"Big, one"');
    expect(csv[1]).toContain(",50,");
    expect(csv[1]).toMatch(/,40,2000$/);
  });

  it("exports Markdown with citations and an estimate label", () => {
    const markdown = auditToMarkdown(audit, {}, "AI Automation Audit: acme.test");
    expect(markdown).toContain("# AI Automation Audit: acme.test");
    expect(markdown).toContain("estimate");
    expect(markdown).toContain("They run a help centre [1]");
    expect(markdown).toContain("1. [Help](https://acme.test/help)");
  });

  it("rejects unsafe source URLs and bad shapes", () => {
    expect(parseAudit(audit).ok).toBe(true);
    const unsafe = {
      ...audit,
      sources: [{ ...audit.sources[0], url: "javascript:alert(1)" }],
    };
    expect(parseAudit(unsafe).ok).toBe(false);
    expect(parseAudit({ company: "x" }).ok).toBe(false);
  });
});
