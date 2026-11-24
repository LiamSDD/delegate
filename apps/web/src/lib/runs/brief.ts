import {
  type Claim,
  type CompanyXrayBriefDraft,
  CompanyXrayBriefDraftSchema,
  type CompanyXraySections,
  SECTION_KEYS,
  SECTION_TITLES,
  type SectionKey,
} from "@delegate/runtime";

export type Brief = CompanyXrayBriefDraft;
export type BriefSection = NonNullable<CompanyXraySections[SectionKey]>;
export type BriefSource = Brief["sources"][number];
export type BriefClaim = Claim;

const SAFE_HREF = /^https?:$/;

function isSafeHref(url: string): boolean {
  try {
    return SAFE_HREF.test(new URL(url).protocol);
  } catch {
    return false;
  }
}

export type ParsedBrief = { ok: true; brief: Brief } | { ok: false; issues: string[] };

export function parseBrief(content: unknown): ParsedBrief {
  const result = CompanyXrayBriefDraftSchema.safeParse(content);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    };
  }
  const unsafe = result.data.sources.filter((source) => !isSafeHref(source.url));
  if (unsafe.length > 0) {
    return {
      ok: false,
      issues: unsafe.slice(0, 5).map((source) => `sources.${source.sourceId}: URL must be http(s)`),
    };
  }
  return { ok: true, brief: result.data };
}

export interface OrderedSection {
  key: SectionKey;
  title: string;
  section: BriefSection | null;
}

export function orderedSections(brief: Brief | null): OrderedSection[] {
  return SECTION_KEYS.map((key) => ({
    key,
    title: SECTION_TITLES[key],
    section: brief?.sections[key] ?? null,
  }));
}

export interface ClaimRow {
  label: string | null;
  claim: Claim;
}

export function sectionRows(section: BriefSection | null): ClaimRow[] {
  if (section?.status !== "ok") return [];
  if ("claims" in section) return section.claims.map((claim) => ({ label: null, claim }));
  if ("competitors" in section)
    return section.competitors.map((entry) => ({ label: entry.name, claim: entry.claim }));
  if ("items" in section)
    return section.items.map((item) => ({ label: item.date ?? null, claim: item.claim }));
  return [
    ...section.strengths.map((claim) => ({ label: "Strength", claim })),
    ...section.weaknesses.map((claim) => ({ label: "Weakness", claim })),
    ...section.opportunities.map((claim) => ({ label: "Opportunity", claim })),
    ...section.threats.map((claim) => ({ label: "Threat", claim })),
  ];
}

export interface CitationTarget {
  number: number;
  source: BriefSource | null;
  sourceId: string;
  host: string | null;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function claimsInReadingOrder(brief: Brief): Claim[] {
  return [
    ...(brief.company.oneLiner === null ? [] : [brief.company.oneLiner]),
    ...orderedSections(brief).flatMap(({ section }) =>
      sectionRows(section).map((row) => row.claim),
    ),
  ];
}

export function citationIndex(brief: Brief): Map<string, CitationTarget> {
  const byId = new Map(brief.sources.map((source) => [source.sourceId, source]));
  const index = new Map<string, CitationTarget>();
  for (const claim of claimsInReadingOrder(brief)) {
    for (const sourceId of claim.citations) {
      if (index.has(sourceId)) continue;
      const source = byId.get(sourceId) ?? null;
      index.set(sourceId, {
        number: index.size + 1,
        source,
        sourceId,
        host: source === null ? null : hostOf(source.url),
      });
    }
  }
  return index;
}

export interface BriefStats {
  sections: number;
  insufficient: number;
  claims: number;
  citations: number;
  verifiedCitations: number;
  sources: number;
}

export function briefStats(brief: Brief): BriefStats {
  const known = new Set(brief.sources.map((source) => source.sourceId));
  const present = orderedSections(brief).filter(({ section }) => section !== null);
  const claims = present.flatMap(({ section }) => sectionRows(section).map((row) => row.claim));
  const citations = claims.flatMap((claim) => claim.citations);
  return {
    sections: present.length,
    insufficient: present.filter(({ section }) => section?.status === "insufficient_evidence")
      .length,
    claims: claims.length,
    citations: citations.length,
    verifiedCitations: citations.filter((id) => known.has(id)).length,
    sources: brief.sources.length,
  };
}

function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_[\]<>#|])/g, "\\$1");
}

function markers(claim: Claim, index: Map<string, CitationTarget>): string {
  const text = claim.citations
    .map((id) => index.get(id)?.number)
    .filter((number) => number !== undefined)
    .map((number) => `[${number}]`)
    .join("");
  return text === "" ? "" : ` ${text}`;
}

export function briefToMarkdown(brief: Brief, heading: string): string {
  const index = citationIndex(brief);
  const lines: string[] = [`# ${escapeMarkdown(heading)}`, ""];
  if (brief.company.oneLiner !== null) {
    lines.push(
      `${escapeMarkdown(brief.company.oneLiner.text)}${markers(brief.company.oneLiner, index)}`,
      "",
    );
  }
  for (const { title, section } of orderedSections(brief)) {
    if (section === null) continue;
    lines.push(`## ${title}`, "");
    if (section.status === "ok") {
      for (const row of sectionRows(section)) {
        const label = row.label === null ? "" : `**${escapeMarkdown(row.label)}:** `;
        lines.push(`- ${label}${escapeMarkdown(row.claim.text)}${markers(row.claim, index)}`);
      }
    } else {
      lines.push(`_Insufficient evidence._ ${escapeMarkdown(section.note)}`);
    }
    lines.push("");
  }
  const cited = [...index.values()].filter((target) => target.source !== null);
  if (cited.length > 0) {
    lines.push("## Sources", "");
    for (const target of cited) {
      if (target.source === null) continue;
      lines.push(
        `${target.number}. [${escapeMarkdown(target.source.title || target.source.url)}](${target.source.url})`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}
