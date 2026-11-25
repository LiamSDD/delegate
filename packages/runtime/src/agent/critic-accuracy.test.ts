import { describe, expect, it } from "vitest";

import { loadPrompt } from "../server";
import { scriptedProvider, testRun, textTurn } from "../testing/fakes";
import { type ModelRequest } from "../providers/types";
import { keptParts, runCritic, spanSupported, type CriticClaim, type CriticDeps } from "./critic";
import { mentionsTarget } from "./specificity";

const prompts = { critic: loadPrompt("critic.v2.md"), editor: loadPrompt("editor.v2.md") };

const EVIDENCE = new Map<string, string[]>([
  [
    "S1",
    [
      "Acme Robotics builds autonomous picking robots for mid-size warehouses.",
      "Robots are leased from 1,900 EUR per robot per month.",
      "Leases include maintenance and a replacement robot within 48 hours.",
      "Our fleet software runs on Kubernetes and integrates with SAP.",
    ],
  ],
  [
    "S2",
    [
      "Northwind Logistics cut picking time by 40 percent with Acme.",
      "Contoso Retail runs 120 Acme robots across three distribution centres.",
    ],
  ],
  [
    "S3",
    [
      "We are hiring robotics engineers in Berlin and Austin.",
      "Acme opened a service hub in Rotterdam in 2024.",
    ],
  ],
  ["S4", ["Marketing is the act of acquiring, satisfying and retaining customers."]],
]);

const FIXTURE_CLAIMS: CriticClaim[] = [
  {
    id: "f1",
    text: "Acme Robotics builds autonomous picking robots for mid-size warehouses",
    citations: ["S1"],
  },
  { id: "f2", text: "Robots are leased from 1,900 EUR per robot per month", citations: ["S1"] },
  { id: "f3", text: "Leases include maintenance", citations: ["S1"] },
  { id: "f4", text: "Acme fleet software runs on Kubernetes", citations: ["S1"] },
  { id: "f5", text: "Acme fleet software integrates with SAP", citations: ["S1"] },
  {
    id: "f6",
    text: "Northwind Logistics cut picking time by 40 percent with Acme",
    citations: ["S2"],
  },
  { id: "f7", text: "Contoso Retail runs 120 Acme robots", citations: ["S2"] },
  { id: "f8", text: "Acme is hiring robotics engineers in Berlin and Austin", citations: ["S3"] },
  { id: "f9", text: "Acme opened a service hub in Rotterdam in 2024", citations: ["S3"] },
  {
    id: "f10",
    text: "Contoso Retail runs Acme robots across three distribution centres",
    citations: ["S2"],
  },
  { id: "f11", text: "Leases include a replacement robot within 48 hours", citations: ["S1"] },
  { id: "f12", text: "Acme builds picking robots", citations: ["S1"] },
  {
    id: "p1",
    text: "Robots are leased from 1,900 EUR per month, and Acme is profitable",
    citations: ["S1"],
  },
  {
    id: "p2",
    text: "Acme opened a service hub in Rotterdam in 2024, and Acme plans a hub in Madrid",
    citations: ["S3"],
  },
  {
    id: "p3",
    text: "Northwind Logistics cut picking time by 40 percent, and Northwind doubled revenue",
    citations: ["S2"],
  },
  {
    id: "p4",
    text: "Acme fleet software runs on Kubernetes, and Acme is SOC 2 certified",
    citations: ["S1"],
  },
  {
    id: "c1",
    text: "Contoso Retail runs 120 Acme robots, and Acme is hiring robotics engineers in Berlin",
    citations: ["S2"],
  },
  {
    id: "c2",
    text: "Leases include maintenance, and Acme opened a service hub in Rotterdam",
    citations: ["S1"],
  },
  { id: "u1", text: "Acme is the market leader in Europe", citations: ["S1"] },
  { id: "u2", text: "Acme raised 50 million in 2023", citations: ["S3"] },
];

const GENERIC_CLAIM: CriticClaim = {
  id: "g1",
  text: "Marketing is the act of acquiring, satisfying and retaining customers",
  citations: ["S4"],
};

function userOf(request: ModelRequest): string {
  const message = request.messages.find((entry) => entry.role === "user");
  return message?.role === "user" ? message.content : "";
}

function contentWords(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N},]*/gu) ?? []).filter(
    (word) => word !== "acme" && (word.length >= 4 || /\d/.test(word)),
  );
}

function atomsOf(claim: string): string[] {
  return claim
    .split(/,\s*and\s+|\s+and\s+(?=acme|northwind|contoso)/i)
    .map((atom) => atom.trim())
    .filter((atom) => atom !== "");
}

function supportedBy(atom: string, quotes: readonly string[]): string | undefined {
  const words = contentWords(atom);
  return quotes.find((quote) => {
    const haystack = quote.toLowerCase();
    return words.every((word) => haystack.includes(word.replace(/,$/, "")));
  });
}

function quotesFor(line: { evidence: { sourceId: string; quote: string }[] }) {
  return line.evidence.map((entry) => entry.quote);
}

function sourceOf(quote: string): string | undefined {
  return [...EVIDENCE.entries()].find(([, quotes]) => quotes.includes(quote))?.[0];
}

function entailmentProvider(options: { informedEditor: boolean }) {
  return scriptedProvider("fake", (request) => {
    const lines = userOf(request)
      .split("\n")
      .filter((line) => line.startsWith('{"id"'))
      .map(
        (line) =>
          JSON.parse(line) as {
            id: string;
            claim: string;
            evidence: { sourceId: string; quote: string }[];
            supportedParts?: string[];
          },
      );
    if (request.system.includes("You are the editor")) {
      const fixes = lines.map((line) => {
        const all = [...EVIDENCE.values()].flat();
        const parts = atomsOf(line.claim)
          .map((atom) => ({ atom, quote: supportedBy(atom, all) }))
          .filter((part): part is { atom: string; quote: string } => part.quote !== undefined);
        if (!options.informedEditor)
          return {
            id: line.id,
            action: "rewrite",
            text: line.claim.replace(/^Acme /, "The company "),
          };
        if (parts.length === 0) return { id: line.id, action: "remove" };
        const asPart = (part: { atom: string; quote: string }) => ({
          text: part.atom,
          citations: [sourceOf(part.quote) ?? "S1"],
          span: part.quote.split(/\s+/).slice(0, 6).join(" "),
        });
        const [first] = parts;
        if (parts.length === 1 && first !== undefined)
          return { id: line.id, action: "rewrite", ...asPart(first) };
        return { id: line.id, action: "split", parts: parts.map(asPart) };
      });
      return textTurn(JSON.stringify({ fixes }));
    }
    const results = lines.map((line) => {
      const quotes = quotesFor(line);
      return {
        id: line.id,
        atoms: atomsOf(line.claim).map((atom) => ({
          text: atom,
          verdict: supportedBy(atom, quotes) === undefined ? "not_enough_info" : "supported",
        })),
        aboutTarget: /acme|northwind|contoso|robots?|leases?/i.test(line.claim),
      };
    });
    return textTurn(JSON.stringify({ results }));
  });
}

function deps(overrides: Partial<CriticDeps> = {}): CriticDeps {
  return {
    stepId: "critic",
    agent: { agentId: "critic_1", say: () => Promise.resolve() },
    spawnEditor: () => Promise.resolve({ agentId: "editor_1", say: () => Promise.resolve() }),
    prompts,
    deliverable: "Company X-ray brief for Acme Robotics",
    evidence: EVIDENCE,
    canFix: () => true,
    ...overrides,
  };
}

describe("critic fix loop accuracy on fixture claims", () => {
  it("reaches at least 95% supported published claims with spans, splits and partial drops", async () => {
    const { ctx } = testRun({ provider: entailmentProvider({ informedEditor: true }) });
    const outcome = await runCritic(ctx, FIXTURE_CLAIMS, deps());
    expect(outcome.report.draftCitationAccuracy).toBeCloseTo(12 / 20, 5);
    expect(outcome.report.citationAccuracy).toBeCloseTo(18 / 20, 5);
    expect(outcome.report.publishedAccuracy).toBeGreaterThanOrEqual(0.95);
    expect(outcome.report.split).toBe(2);
    expect(outcome.removed.map((claim) => claim.id).sort()).toEqual(["u1", "u2"]);
    expect(keptParts(outcome.kept, "c1").map((claim) => claim.citations)).toEqual([["S2"], ["S3"]]);
    expect(keptParts(outcome.kept, "p1")[0]?.text).toBe(
      "Robots are leased from 1,900 EUR per month",
    );
    for (const claim of outcome.kept.values()) expect(claim.support).toBe("supported");
  });

  it("is honest about the v1-style loop: partial claims stay weak and lower published accuracy", async () => {
    const { ctx } = testRun({ provider: entailmentProvider({ informedEditor: false }) });
    const outcome = await runCritic(ctx, FIXTURE_CLAIMS, deps({ keepPartialAfterFix: true }));
    expect(outcome.report.citationAccuracy).toBeCloseTo(12 / 20, 5);
    expect(outcome.report.publishedAccuracy).toBeLessThan(0.95);
  });

  it("rejects a rewrite whose supporting span is not in the cited evidence", async () => {
    const provider = scriptedProvider("fake", (request) => {
      const ids = [...userOf(request).matchAll(/"id":"([^"]+)"/g)].map((match) => match[1] ?? "");
      if (request.system.includes("You are the editor"))
        return textTurn(
          JSON.stringify({
            fixes: ids.map((id) => ({
              id,
              action: "rewrite",
              text: "Acme is the leading robotics vendor in Europe",
              citations: ["S1"],
              span: "the leading robotics vendor in Europe",
            })),
          }),
        );
      return textTurn(
        JSON.stringify({
          results: ids.map((id) => ({ id, atoms: [{ text: id, verdict: "not_enough_info" }] })),
        }),
      );
    });
    const said: string[] = [];
    const outcome = await runCritic(
      testRun({ provider }).ctx,
      [{ id: "x", text: "Acme leads the European market", citations: ["S1"] }],
      deps({
        agent: { agentId: "critic_1", say: (text) => Promise.resolve(void said.push(text)) },
      }),
    );
    expect(outcome.kept.size).toBe(0);
    expect(said.join(" ")).toMatch(/1 rewrite was rejected/);
    expect(spanSupported("leased from 1,900 EUR", ["S1"], EVIDENCE)).toBe(true);
    expect(spanSupported("leased from 1,900 EUR", ["S2"], EVIDENCE)).toBe(false);
  });

  it("moves claims the critic judges not about the target out of the deliverable", async () => {
    const { ctx, events } = testRun({ provider: entailmentProvider({ informedEditor: true }) });
    const outcome = await runCritic(ctx, [...FIXTURE_CLAIMS.slice(0, 3), GENERIC_CLAIM], {
      ...deps(),
      specificity: {
        target: "Acme Robotics",
        mentionsTarget: (text) => mentionsTarget(text, { names: ["Acme Robotics"] }),
      },
    });
    expect(outcome.generic.map((claim) => claim.id)).toEqual(["g1"]);
    expect(outcome.kept.has("g1")).toBe(false);
    expect(outcome.report).toMatchObject({ genericRemoved: 1, claimsChecked: 3, supported: 3 });
    expect(
      events.some(
        (event) => event.type === "critic.flagged" && event.payload.claimId === "g1:generic",
      ),
    ).toBe(true);
  });
});
