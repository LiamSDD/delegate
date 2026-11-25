import { keptParts, type CriticClaim, type KeptClaim } from "../../agent/critic";
import { classifyClaim, type SpecificityContext } from "../../agent/specificity";
import { SECTION_KEYS, type Claim, type CompanyXraySections } from "./brief";

export const CRITIC_REMOVED_NOTE =
  "The critic removed this section's claims because their cited sources did not support them.";
export const GENERIC_REMOVED_NOTE =
  "Only general background, not findings about this company, was drafted for this section, so it was removed.";

type ClaimsKey = "offering" | "customers" | "market" | "positioning" | "techStack";
const CLAIM_KEYS: readonly ClaimsKey[] = [
  "offering",
  "customers",
  "market",
  "positioning",
  "techStack",
];
const SWOT_LISTS = ["strengths", "weaknesses", "opportunities", "threats"] as const;

const toCritic = (id: string, claim: Claim): CriticClaim => ({
  id,
  text: claim.text,
  citations: [...claim.citations],
});

export function listBriefClaims(
  sections: CompanyXraySections,
  oneLiner: Claim | null,
): CriticClaim[] {
  const claims: CriticClaim[] = oneLiner === null ? [] : [toCritic("oneLiner", oneLiner)];
  for (const key of SECTION_KEYS) {
    const value = sections[key];
    if (value.status !== "ok") continue;
    if ("claims" in value)
      value.claims.forEach((claim, index) => claims.push(toCritic(`${key}.${index}`, claim)));
    if ("competitors" in value)
      value.competitors.forEach((entry, index) =>
        claims.push(toCritic(`competitors.${index}`, entry.claim)),
      );
    if ("items" in value)
      value.items.forEach((entry, index) => claims.push(toCritic(`news.${index}`, entry.claim)));
    if ("strengths" in value)
      for (const list of SWOT_LISTS)
        value[list].forEach((claim, index) =>
          claims.push(toCritic(`swot.${list}.${index}`, claim)),
        );
  }
  return claims;
}

export function applyBriefClaims(
  sections: CompanyXraySections,
  oneLiner: Claim | null,
  kept: ReadonlyMap<string, KeptClaim>,
  note: string = CRITIC_REMOVED_NOTE,
): { sections: CompanyXraySections; oneLiner: Claim | null } {
  const toClaim = (claim: KeptClaim): Claim => ({
    text: claim.text,
    citations: claim.citations,
    ...(claim.support === "supported" ? {} : { support: claim.support }),
  });
  const pickAll = (id: string): Claim[] => keptParts(kept, id).map(toClaim);
  const pick = (id: string): Claim | undefined => pickAll(id)[0];
  const removed = { status: "insufficient_evidence" as const, note };
  const next = { ...sections };
  for (const key of CLAIM_KEYS) {
    const value = sections[key];
    if (value.status !== "ok") continue;
    const claims = value.claims.flatMap((_, index) => pickAll(`${key}.${index}`));
    next[key] = claims.length === 0 ? removed : { status: "ok", claims };
  }
  const competitors = sections.competitors;
  if (competitors.status === "ok") {
    const kept2 = competitors.competitors.flatMap((entry, index) => {
      const claim = pick(`competitors.${index}`);
      return claim === undefined ? [] : [{ name: entry.name, claim }];
    });
    next.competitors = kept2.length === 0 ? removed : { status: "ok", competitors: kept2 };
  }
  const news = sections.news;
  if (news.status === "ok") {
    const items = news.items.flatMap((item, index) => {
      const claim = pick(`news.${index}`);
      return claim === undefined
        ? []
        : [{ ...(item.date === undefined ? {} : { date: item.date }), claim }];
    });
    next.news = items.length === 0 ? removed : { status: "ok", items };
  }
  const swot = sections.swot;
  if (swot.status === "ok") {
    const lists = Object.fromEntries(
      SWOT_LISTS.map((list) => [
        list,
        swot[list].flatMap((_, index) => pickAll(`swot.${list}.${index}`)),
      ]),
    ) as Record<(typeof SWOT_LISTS)[number], Claim[]>;
    const total = SWOT_LISTS.reduce((sum, list) => sum + lists[list].length, 0);
    next.swot = total === 0 ? removed : { status: "ok", ...lists };
  }
  return { sections: next, oneLiner: oneLiner === null ? null : (pick("oneLiner") ?? null) };
}

export interface BriefSpecificity {
  sections: CompanyXraySections;
  oneLiner: Claim | null;
  generic: CriticClaim[];
  specific: number;
}

export function dropGenericBriefClaims(
  sections: CompanyXraySections,
  oneLiner: Claim | null,
  context: SpecificityContext,
): BriefSpecificity {
  const claims = listBriefClaims(sections, oneLiner);
  const kept = new Map<string, KeptClaim>();
  const generic: CriticClaim[] = [];
  for (const claim of claims) {
    if (classifyClaim(claim, context).label === "generic") generic.push(claim);
    else kept.set(claim.id, { ...claim, support: "supported" });
  }
  if (generic.length === 0) return { sections, oneLiner, generic, specific: claims.length };
  const applied = applyBriefClaims(sections, oneLiner, kept, GENERIC_REMOVED_NOTE);
  return { ...applied, generic, specific: kept.size };
}
