import { describe, expect, it } from "vitest";

import {
  classifyClaim,
  isDefinitional,
  mentionsTarget,
  specificityScore,
  splitBySpecificity,
  type SpecificityContext,
  type SpecificitySource,
} from "./specificity";

const sources = new Map<string, SpecificitySource>([
  [
    "S1",
    { kind: "company_site", title: "Northwind | Newsroom", url: "https://northwind.example/news" },
  ],
  [
    "S2",
    {
      kind: "wikipedia",
      title: "Wikipedia: Marketing",
      url: "https://en.wikipedia.org/wiki/Marketing",
    },
  ],
  [
    "S3",
    {
      kind: "wikipedia",
      title: "Wikipedia: Software agent",
      url: "https://en.wikipedia.org/wiki/Software_agent",
    },
  ],
  [
    "S4",
    {
      kind: "wikipedia",
      title: "Northwind Traders",
      url: "https://en.wikipedia.org/wiki/Northwind_Traders",
    },
  ],
  ["S5", { kind: "github", title: "GitHub: northwind", url: "https://github.com/northwind" }],
]);

const context: SpecificityContext = {
  target: { names: ["Northwind Traders", "northwind"] },
  sources,
};
const topicOnly: SpecificityContext = { target: { names: [] }, sources };

const FIXTURE: {
  text: string;
  citations: string[];
  expected: "specific" | "generic";
  note: string;
}[] = [
  {
    text: "Marketing is the act of acquiring, satisfying and retaining customers.",
    citations: ["S2"],
    expected: "generic",
    note: "encyclopedia definition",
  },
  {
    text: "An AI agent can make decisions and take actions on behalf of a user.",
    citations: ["S3"],
    expected: "generic",
    note: "generic subject",
  },
  {
    text: "A software agent is a computer program that acts for a user.",
    citations: ["S3"],
    expected: "generic",
    note: "definition",
  },
  {
    text: "Digital marketing spending grew 12% in 2023.",
    citations: ["S2"],
    expected: "generic",
    note: "topic-only source, no target",
  },
  {
    text: "Companies often use chatbots to answer customer questions.",
    citations: ["S1"],
    expected: "generic",
    note: "generic plural subject even on the company site",
  },
  {
    text: "Context: marketing teams increasingly automate campaign reporting.",
    citations: ["S2"],
    expected: "generic",
    note: "explicitly framed as context",
  },
  {
    text: "Northwind launched a loyalty programme with 4 million members in 2024.",
    citations: ["S1"],
    expected: "specific",
    note: "names the target",
  },
  {
    text: "Northwind's newsroom lists three campaign launches in October.",
    citations: ["S1"],
    expected: "specific",
    note: "possessive target",
  },
  {
    text: "The company is the largest wholesale grocer in the Benelux.",
    citations: ["S4"],
    expected: "specific",
    note: "anaphora from a source about the target",
  },
  {
    text: "Leases include maintenance and a replacement unit within 48 hours.",
    citations: ["S1"],
    expected: "specific",
    note: "company-site fact without the name",
  },
  {
    text: "The repository ships a TypeScript SDK and a CLI.",
    citations: ["S5"],
    expected: "specific",
    note: "repo source",
  },
  {
    text: "Das Marketing ist die Ausrichtung eines Unternehmens auf den Markt.",
    citations: ["S2"],
    expected: "generic",
    note: "German definition",
  },
  {
    text: "Le marketing est l'ensemble des méthodes d'une organisation.",
    citations: ["S2"],
    expected: "generic",
    note: "French definition",
  },
  {
    text: "El marketing es un proceso social y administrativo.",
    citations: ["S2"],
    expected: "generic",
    note: "Spanish definition",
  },
  {
    text: "Il marketing è un ramo dell'economia.",
    citations: ["S2"],
    expected: "generic",
    note: "Italian definition",
  },
  {
    text: "Northwind eröffnete 2024 ein Logistikzentrum in Venlo.",
    citations: ["S1"],
    expected: "specific",
    note: "German, names the target",
  },
  {
    text: "Northwind a lancé une application mobile en 2023.",
    citations: ["S1"],
    expected: "specific",
    note: "French, names the target",
  },
];

describe("classifyClaim on fixture claims", () => {
  for (const claim of FIXTURE)
    it(`${claim.expected}: ${claim.note}`, () => {
      expect(classifyClaim(claim, context).label).toBe(claim.expected);
    });

  it("explains why a claim is generic", () => {
    const verdict = classifyClaim(FIXTURE[0] ?? { text: "", citations: [] }, context);
    expect(verdict.reasons.join("; ")).toMatch(/defines a generic concept/);
    expect(verdict.reasons.join("; ")).toMatch(/general reference articles/);
  });
});

describe("goals without a target entity", () => {
  it("drops definitions but keeps concrete practice claims", () => {
    expect(
      classifyClaim(
        { text: "Marketing is the act of acquiring customers.", citations: ["S2"] },
        topicOnly,
      ).label,
    ).toBe("generic");
    expect(
      classifyClaim(
        {
          text: "Weekly campaign reviews cut reporting time by 30% in the 2023 Gartner survey.",
          citations: ["S2"],
        },
        topicOnly,
      ).label,
    ).toBe("specific");
    expect(
      classifyClaim({ text: "An agent can help a team.", citations: ["S3"] }, topicOnly).label,
    ).toBe("generic");
  });
});

describe("helpers", () => {
  it("matches target names on word boundaries, folding accents", () => {
    expect(mentionsTarget("Nestlé opened a plant", { names: ["Nestle"] })).toBe(true);
    expect(mentionsTarget("Northwinds of change", { names: ["Northwind"] })).toBe(true);
    expect(mentionsTarget("A northwesterly wind", { names: ["Northwind"] })).toBe(false);
  });

  it("detects definitional sentences only at the start of the claim", () => {
    expect(isDefinitional("Search engine optimisation is the process of improving a site.")).toBe(
      true,
    );
    expect(isDefinitional("Northwind sells tea. Tea is a drink.")).toBe(false);
  });

  it("moves at most two generic claims to context and drops the rest", () => {
    const split = splitBySpecificity(FIXTURE, context);
    expect(split.context).toHaveLength(2);
    expect(split.dropped.length).toBe(
      FIXTURE.filter((claim) => claim.expected === "generic").length - 2,
    );
    expect(split.specific.every((claim) => claim.expected === "specific")).toBe(true);
    const score = specificityScore(
      split.specific.length,
      split.context.length + split.dropped.length,
      split.context.length,
    );
    expect(score.score).toBeCloseTo(7 / 17, 3);
    expect(score.dropped).toBe(split.dropped.length);
  });
});
