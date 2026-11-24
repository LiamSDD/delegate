import { z } from "zod";

import { SOURCE_KINDS, SourceIdSchema, SourceRecordSchema } from "../../tools/sources";

export const SECTION_KEYS = [
  "offering",
  "customers",
  "market",
  "competitors",
  "positioning",
  "news",
  "swot",
  "techStack",
] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

export const SECTION_TITLES: Record<SectionKey, string> = {
  offering: "Offering",
  customers: "Customers and ICP",
  market: "Market",
  competitors: "Competitors",
  positioning: "Positioning",
  news: "Recent news",
  swot: "SWOT",
  techStack: "Tech-stack signals",
};

function splitCitations(value: unknown): unknown {
  if (typeof value === "string") return value.split(/[\s,;]+/);
  return value;
}

function cleanCitation(value: unknown): unknown {
  return typeof value === "string" ? value.replace(/[[\]()]/g, "").trim() : value;
}

const CitationsSchema = z.preprocess((value) => {
  const list = splitCitations(value);
  return Array.isArray(list) ? list.map(cleanCitation).filter((entry) => entry !== "") : list;
}, z.array(SourceIdSchema).min(1).max(8));

export const ClaimSchema = z.object({
  text: z.string().trim().min(1).max(600),
  citations: CitationsSchema,
});
export type Claim = z.infer<typeof ClaimSchema>;

export const InsufficientEvidenceSchema = z.object({
  status: z.literal("insufficient_evidence"),
  note: z.string().trim().min(1).max(500),
});

const ClaimsSectionSchema = z.object({
  status: z.literal("ok"),
  claims: z.array(ClaimSchema).min(1).max(8),
});
const CompetitorsSectionSchema = z.object({
  status: z.literal("ok"),
  competitors: z
    .array(z.object({ name: z.string().trim().min(1).max(120), claim: ClaimSchema }))
    .min(1)
    .max(5),
});
const NewsSectionSchema = z.object({
  status: z.literal("ok"),
  items: z
    .array(z.object({ date: z.string().trim().max(40).optional(), claim: ClaimSchema }))
    .min(1)
    .max(8),
});
const SwotList = z.array(ClaimSchema).max(4).default([]);
const SwotSectionSchema = z
  .object({
    status: z.literal("ok"),
    strengths: SwotList,
    weaknesses: SwotList,
    opportunities: SwotList,
    threats: SwotList,
  })
  .refine(
    (swot) =>
      swot.strengths.length +
        swot.weaknesses.length +
        swot.opportunities.length +
        swot.threats.length >
      0,
    "SWOT needs at least one cited entry",
  );

const section = <T extends z.ZodType>(schema: T) => z.union([schema, InsufficientEvidenceSchema]);

export const CompanyXraySectionsSchema = z.object({
  offering: section(ClaimsSectionSchema),
  customers: section(ClaimsSectionSchema),
  market: section(ClaimsSectionSchema),
  competitors: section(CompetitorsSectionSchema),
  positioning: section(ClaimsSectionSchema),
  news: section(NewsSectionSchema),
  swot: section(SwotSectionSchema),
  techStack: section(ClaimsSectionSchema),
});
export type CompanyXraySections = z.infer<typeof CompanyXraySectionsSchema>;

export const CompanyXraySynthesisSchema = z.object({
  companyName: z.string().trim().min(1).max(120),
  oneLiner: ClaimSchema.nullable(),
  sections: CompanyXraySectionsSchema,
});
export type CompanyXraySynthesis = z.infer<typeof CompanyXraySynthesisSchema>;

export const CompanyXrayDraftOutputSchema = z.object({
  companyName: z.string().trim().min(1).max(120),
  oneLiner: z.unknown().optional(),
  sections: z.record(z.string(), z.unknown()),
});
export type CompanyXrayDraftOutput = z.infer<typeof CompanyXrayDraftOutputSchema>;

export interface NormalisedSynthesis {
  synthesis: CompanyXraySynthesis;
  malformed: SectionKey[];
  discarded: number;
}

const MALFORMED_NOTE =
  "The drafted section was missing or did not match the brief schema, so it was left out.";
const MAX_CLAIMS = 8;
const MAX_COMPETITORS = 5;
const MAX_NEWS = 8;
const MAX_SWOT = 4;
const INLINE_CITATION = /[[(]?\bS\d{1,4}\b[\])]?/g;

const ItemRecordSchema = z.record(z.string(), z.unknown());

function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function normaliseSynthesis(raw: CompanyXrayDraftOutput): NormalisedSynthesis {
  let discarded = 0;
  const malformed: SectionKey[] = [];
  const salvageClaim = (item: unknown): Claim | undefined => {
    const candidate =
      typeof item === "string"
        ? {
            text: item
              .replace(INLINE_CITATION, " ")
              .replace(/\s+/g, " ")
              .replace(/[\s,;:]+$/, "")
              .trim(),
            citations: item.match(/\bS\d{1,4}\b/g) ?? [],
          }
        : item;
    const parsed = ClaimSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
    discarded += 1;
    return undefined;
  };
  const claims = (value: unknown, max: number): Claim[] =>
    listOf(value)
      .map(salvageClaim)
      .filter((claim): claim is Claim => claim !== undefined)
      .slice(0, max);
  const insufficient = (key: SectionKey) => {
    malformed.push(key);
    return { status: "insufficient_evidence" as const, note: MALFORMED_NOTE };
  };
  const section = (key: SectionKey): unknown => {
    const record = ItemRecordSchema.safeParse(raw.sections[key]);
    if (!record.success) return insufficient(key);
    const value = record.data;
    if (value.status === "insufficient_evidence") {
      const declared = InsufficientEvidenceSchema.safeParse(value);
      return declared.success ? declared.data : insufficient(key);
    }
    switch (key) {
      case "competitors": {
        const competitors = listOf(value.competitors).flatMap((entry) => {
          const item = ItemRecordSchema.safeParse(entry);
          const name =
            item.success && typeof item.data.name === "string" ? item.data.name.trim() : "";
          const claim = item.success ? salvageClaim(item.data.claim) : undefined;
          if (!item.success) discarded += 1;
          return name === "" || claim === undefined ? [] : [{ name: name.slice(0, 120), claim }];
        });
        return competitors.length === 0
          ? insufficient(key)
          : { status: "ok", competitors: competitors.slice(0, MAX_COMPETITORS) };
      }
      case "news": {
        const items = listOf(value.items).flatMap((entry) => {
          const item = ItemRecordSchema.safeParse(entry);
          if (!item.success) {
            discarded += 1;
            return [];
          }
          const claim = salvageClaim(item.data.claim);
          const date =
            typeof item.data.date === "string" && item.data.date.trim() !== ""
              ? item.data.date.trim().slice(0, 40)
              : undefined;
          return claim === undefined ? [] : [{ ...(date === undefined ? {} : { date }), claim }];
        });
        return items.length === 0
          ? insufficient(key)
          : { status: "ok", items: items.slice(0, MAX_NEWS) };
      }
      case "swot": {
        const swot = {
          strengths: claims(value.strengths, MAX_SWOT),
          weaknesses: claims(value.weaknesses, MAX_SWOT),
          opportunities: claims(value.opportunities, MAX_SWOT),
          threats: claims(value.threats, MAX_SWOT),
        };
        const total =
          swot.strengths.length +
          swot.weaknesses.length +
          swot.opportunities.length +
          swot.threats.length;
        return total === 0 ? insufficient(key) : { status: "ok", ...swot };
      }
      default: {
        const kept = claims(value.claims, MAX_CLAIMS);
        return kept.length === 0 ? insufficient(key) : { status: "ok", claims: kept };
      }
    }
  };
  const oneLiner =
    raw.oneLiner === undefined || raw.oneLiner === null
      ? null
      : (salvageClaim(raw.oneLiner) ?? null);
  const synthesis = CompanyXraySynthesisSchema.parse({
    companyName: raw.companyName,
    oneLiner,
    sections: Object.fromEntries(SECTION_KEYS.map((key) => [key, section(key)])),
  });
  return { synthesis, malformed, discarded };
}

export const BriefSourceSchema = SourceRecordSchema.extend({ quotes: z.array(z.string()).max(12) });
export type BriefSource = z.infer<typeof BriefSourceSchema>;

export const SourceMixSchema = z.object(
  Object.fromEntries(SOURCE_KINDS.map((kind) => [kind, z.number().int().nonnegative()])) as Record<
    (typeof SOURCE_KINDS)[number],
    z.ZodNumber
  >,
);

type SectionsInput = { [K in SectionKey]?: CompanyXraySections[K] | undefined };

function claimsOf(sections: SectionsInput): Claim[] {
  const claims: Claim[] = [];
  for (const key of SECTION_KEYS) {
    const value = sections[key];
    if (value?.status !== "ok") continue;
    if ("claims" in value) claims.push(...value.claims);
    if ("competitors" in value) claims.push(...value.competitors.map((entry) => entry.claim));
    if ("items" in value) claims.push(...value.items.map((entry) => entry.claim));
    if ("strengths" in value)
      claims.push(
        ...value.strengths,
        ...value.weaknesses,
        ...value.opportunities,
        ...value.threats,
      );
  }
  return claims;
}

const briefShape = {
  missionId: z.literal("company-xray"),
  company: z.object({ name: z.string().min(1), url: z.url(), oneLiner: ClaimSchema.nullable() }),
  focus: z.string().optional(),
  sources: z.array(BriefSourceSchema),
  sourceMix: SourceMixSchema,
  generatedAt: z.iso.datetime({ offset: true }),
  promptVersions: z.array(z.string().min(1)),
};

function citationIntegrity(
  brief: {
    company: { oneLiner: Claim | null };
    sections: SectionsInput;
    sources: { sourceId: string }[];
  },
  ctx: z.RefinementCtx,
) {
  const known = new Set(brief.sources.map((source) => source.sourceId));
  const claims = [
    ...claimsOf(brief.sections),
    ...(brief.company.oneLiner === null ? [] : [brief.company.oneLiner]),
  ];
  for (const claim of claims) {
    for (const citation of claim.citations) {
      if (!known.has(citation))
        ctx.addIssue({ code: "custom", message: `Citation ${citation} does not match any source` });
    }
  }
}

export const CompanyXrayBriefSchema = z
  .object({ ...briefShape, status: z.literal("complete"), sections: CompanyXraySectionsSchema })
  .superRefine(citationIntegrity);
export type CompanyXrayBrief = z.infer<typeof CompanyXrayBriefSchema>;

export const CompanyXrayBriefDraftSchema = z
  .object({
    ...briefShape,
    status: z.enum(["draft", "complete"]),
    sections: CompanyXraySectionsSchema.partial(),
  })
  .superRefine(citationIntegrity);
export type CompanyXrayBriefDraft = z.infer<typeof CompanyXrayBriefDraftSchema>;

export interface DroppedClaim {
  section: SectionKey | "oneLiner";
  text: string;
  citations: string[];
}

export interface CitationCheck {
  oneLiner: Claim | null;
  sections: CompanyXraySections;
  dropped: DroppedClaim[];
}

const NO_VALID_CITATIONS =
  "Drafted claims for this section cited no fetched source, so they were removed.";

export function enforceCitations(
  synthesis: CompanyXraySynthesis,
  known: ReadonlySet<string>,
): CitationCheck {
  const dropped: DroppedClaim[] = [];
  const keep = (key: DroppedClaim["section"], claim: Claim): Claim | undefined => {
    const citations = [...new Set(claim.citations.filter((citation) => known.has(citation)))];
    if (citations.length === 0) {
      dropped.push({ section: key, text: claim.text, citations: claim.citations });
      return undefined;
    }
    return { text: claim.text, citations };
  };
  const keepAll = (key: SectionKey, claims: readonly Claim[]): Claim[] =>
    claims.map((claim) => keep(key, claim)).filter((claim): claim is Claim => claim !== undefined);
  const insufficient = { status: "insufficient_evidence" as const, note: NO_VALID_CITATIONS };
  const input = synthesis.sections;

  const claimsSection = (
    key: "offering" | "customers" | "market" | "positioning" | "techStack",
  ): CompanyXraySections[typeof key] => {
    const value = input[key];
    if (value.status !== "ok") return value;
    const claims = keepAll(key, value.claims);
    return claims.length === 0 ? insufficient : { status: "ok", claims };
  };

  const competitors = ((): CompanyXraySections["competitors"] => {
    const value = input.competitors;
    if (value.status !== "ok") return value;
    const kept = value.competitors.flatMap((entry) => {
      const claim = keep("competitors", entry.claim);
      return claim === undefined ? [] : [{ name: entry.name, claim }];
    });
    return kept.length === 0 ? insufficient : { status: "ok", competitors: kept };
  })();

  const news = ((): CompanyXraySections["news"] => {
    const value = input.news;
    if (value.status !== "ok") return value;
    const kept = value.items.flatMap((item) => {
      const claim = keep("news", item.claim);
      return claim === undefined
        ? []
        : [{ ...(item.date === undefined ? {} : { date: item.date }), claim }];
    });
    return kept.length === 0 ? insufficient : { status: "ok", items: kept };
  })();

  const swot = ((): CompanyXraySections["swot"] => {
    const value = input.swot;
    if (value.status !== "ok") return value;
    const kept = {
      strengths: keepAll("swot", value.strengths),
      weaknesses: keepAll("swot", value.weaknesses),
      opportunities: keepAll("swot", value.opportunities),
      threats: keepAll("swot", value.threats),
    };
    const total =
      kept.strengths.length +
      kept.weaknesses.length +
      kept.opportunities.length +
      kept.threats.length;
    return total === 0 ? insufficient : { status: "ok", ...kept };
  })();

  return {
    oneLiner: synthesis.oneLiner === null ? null : (keep("oneLiner", synthesis.oneLiner) ?? null),
    sections: {
      offering: claimsSection("offering"),
      customers: claimsSection("customers"),
      market: claimsSection("market"),
      competitors,
      positioning: claimsSection("positioning"),
      news,
      swot,
      techStack: claimsSection("techStack"),
    },
    dropped,
  };
}

export function citedSourceIds(sections: SectionsInput, oneLiner: Claim | null): Set<string> {
  return new Set(
    [...claimsOf(sections), ...(oneLiner === null ? [] : [oneLiner])].flatMap(
      (claim) => claim.citations,
    ),
  );
}

export function dropUnsupportedDates(
  sections: CompanyXraySections,
  evidenceBySource: ReadonlyMap<string, string>,
): { sections: CompanyXraySections; dropped: number } {
  const news = sections.news;
  if (news.status !== "ok") return { sections, dropped: 0 };
  const normalise = (text: string) => text.toLowerCase().replace(/\s+/g, " ");
  let dropped = 0;
  const items = news.items.map((item) => {
    if (item.date === undefined) return item;
    const date = normalise(item.date);
    const supported = item.claim.citations.some((sourceId) =>
      normalise(evidenceBySource.get(sourceId) ?? "").includes(date),
    );
    if (supported) return item;
    dropped += 1;
    return { claim: item.claim };
  });
  return { sections: { ...sections, news: { status: "ok", items } }, dropped };
}
