import { describe, expect, it } from "vitest";

import { analyseGoal, brandCandidates, extractDomain, topicQueries } from "./target";

describe("extractDomain", () => {
  it("finds a typed domain or URL and normalises it to the homepage", () => {
    expect(extractDomain("Grow self-serve signups for linear.app in Q3")).toEqual({
      url: "https://linear.app/",
      host: "linear.app",
    });
    expect(extractDomain("Audit https://www.Stripe.com/pricing for churn risks")).toEqual({
      url: "https://stripe.com/",
      host: "stripe.com",
    });
  });

  it("ignores emails, file names and repository URLs", () => {
    expect(extractDomain("Email ops@acme.com about the rollout")).toBeNull();
    expect(extractDomain("Clean up config.json and index.ts")).toBeNull();
    expect(extractDomain("Harden https://github.com/vercel/next.js before launch")).toBeNull();
  });
});

describe("brandCandidates", () => {
  it("takes lower-case possessives and capitalised names, skipping the first word and jargon", () => {
    expect(brandCandidates("I want to achieve nike's marketing and agentic work")).toEqual([
      "nike",
    ]);
    expect(brandCandidates("Improve onboarding at Deutsche Bahn with AI agents")).toEqual([
      "Deutsche Bahn",
    ]);
    expect(brandCandidates("Reduce churn for our SaaS product")).toEqual([]);
  });

  it("uses a repository owner as a brand", () => {
    expect(brandCandidates("Review https://github.com/vercel/next.js")).toEqual(["vercel"]);
  });
});

describe("topicQueries", () => {
  it("splits the goal into short keyword queries without the company", () => {
    expect(topicQueries("I want to achieve nike's marketing and agentic work", ["nike"])).toEqual([
      "marketing",
      "agentic",
    ]);
    expect(topicQueries("Cut support ticket volume, automate invoice processing", [])).toEqual([
      "Cut support ticket volume",
      "automate invoice processing",
    ]);
  });
});

describe("analyseGoal", () => {
  it("prefers the given URL, then a typed domain, then brand candidates", () => {
    expect(analyseGoal("Plan our EU expansion", "https://www.acme.example/")).toMatchObject({
      domain: { url: "https://www.acme.example/", host: "acme.example" },
      brands: [],
    });
    expect(analyseGoal("I want to achieve nike's marketing and agentic work")).toMatchObject({
      domain: null,
      brands: ["nike"],
      queries: ["marketing", "agentic"],
    });
    expect(analyseGoal("Make our weekly planning less painful")).toMatchObject({
      domain: null,
      brands: [],
    });
  });
});
