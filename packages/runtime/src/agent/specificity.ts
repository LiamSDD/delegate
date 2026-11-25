import { type SourceKind } from "../tools/sources";

export const SPECIFICITY_LIMITS = {
  contextLines: 2,
  minNameChars: 2,
  subjectWords: 6,
} as const;

export interface SpecificityTarget {
  names: readonly string[];
}

export interface SpecificitySource {
  kind: SourceKind;
  title: string;
  url: string;
}

export interface SpecificityContext {
  target: SpecificityTarget;
  sources: ReadonlyMap<string, SpecificitySource>;
}

export type SpecificityLabel = "specific" | "generic";

export interface SpecificityVerdict {
  label: SpecificityLabel;
  reasons: string[];
}

export interface ClaimLike {
  text: string;
  citations: readonly string[];
}

const TARGET_OWNED_KINDS: ReadonlySet<SourceKind> = new Set([
  "company_site",
  "github",
  "feed",
  "connector",
]);

const NAME_STOPWORDS = new Set(
  "the a an and of for inc incorporated corp corporation co company ltd limited llc plc gmbh ag sa se nv bv group holdings holding www com org net io ai app".split(
    " ",
  ),
);

export function fold(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

function wordsOf(text: string): string[] {
  return fold(text).match(/[\p{L}\p{N}][\p{L}\p{N}&'’-]*/gu) ?? [];
}

export function targetTerms(target: SpecificityTarget): string[] {
  const terms = new Set<string>();
  for (const name of target.names) {
    const whole = wordsOf(name).join(" ");
    if (whole.length >= SPECIFICITY_LIMITS.minNameChars) terms.add(whole);
    const stem = wordsOf(name).find((word) => word.length >= 3 && !NAME_STOPWORDS.has(word));
    if (stem !== undefined) terms.add(stem);
  }
  return [...terms];
}

export function mentionsTarget(text: string, target: SpecificityTarget): boolean {
  const terms = targetTerms(target);
  if (terms.length === 0) return false;
  const haystack = ` ${wordsOf(text).join(" ")} `;
  return terms.some((term) => haystack.includes(` ${term} `) || haystack.includes(` ${term}s `));
}

const DEFINITIONAL: readonly RegExp[] = [
  /^(?:an?|the)?\s*(?:[\p{L}\p{N}'’-]+\s+){0,5}(?:is|are|was|were)\s+(?:an?|the|one of the|any|all)\s/iu,
  /^(?:an?|the)?\s*(?:[\p{L}\p{N}'’-]+\s+){0,5}(?:refers? to|means|denotes|describes|can be defined as|is defined as|is known as|encompasses|consists of)\b/iu,
  /^(?:ein|eine|der|die|das)?\s*(?:[\p{L}\p{N}'’-]+\s+){0,5}(?:ist|sind|bezeichnet|bedeutet|beschreibt)\s+(?:ein|eine|einer|der|die|das|den)\b/iu,
  /^(?:un|une|le|la|les|l['’])?\s*(?:[\p{L}\p{N}'’-]+\s+){0,5}(?:est|sont|désigne|designe|signifie)\s+(?:un|une|le|la|les|l['’]|l’ensemble|l'ensemble)/iu,
  /^(?:un|una|el|la|los|las)?\s*(?:[\p{L}\p{N}'’-]+\s+){0,5}(?:es|son|se refiere a|significa)\s+(?:un|una|el|la|los|las|a)\b/iu,
  /^(?:um|uma|o|a|os|as)?\s*(?:[\p{L}\p{N}'’-]+\s+){0,5}(?:é|e|são|sao|refere-se a)\s+(?:um|uma|o|a|os|as)\b/iu,
  /^(?:un|uno|una|il|lo|la|i|gli|le|l['’])?\s*(?:[\p{L}\p{N}'’-]+\s+){0,5}(?:è|sono|si riferisce a)\s+(?:un|uno|una|il|lo|la|l['’])/iu,
  /^(?:een|de|het)?\s*(?:[\p{L}\p{N}'’-]+\s+){0,5}(?:is|zijn|verwijst naar|betekent)\s+(?:een|de|het)\b/iu,
];

const GENERIC_SUBJECT: readonly RegExp[] = [
  /^(?:an?|any|every|each)\s+(?:[\p{L}\p{N}'’-]+\s+){0,4}(?:can|may|might|could|will|would|should|must|typically|usually|often|generally|helps?|allows?|enables?|is|are)\b/iu,
  /^(?:companies|businesses|organi[sz]ations|firms|brands|marketers|teams|enterprises|agents|users|customers|people|many|most|some)\s+(?:[\p{L}\p{N}'’-]+\s+){0,3}(?:can|may|might|could|will|should|must|typically|usually|often|generally|tend to|use|need|are|have)\b/iu,
  /^(?:in general|generally|typically|traditionally|historically|broadly|by definition|in theory|in practice)\b/iu,
  /^(?:ein|eine|jede[rs]?)\s+(?:[\p{L}\p{N}'’-]+\s+){0,4}(?:kann|können|soll|muss|hilft|ermöglicht)\b/iu,
  /^(?:un|une|chaque)\s+(?:[\p{L}\p{N}'’-]+\s+){0,4}(?:peut|peuvent|doit|permet|aide)\b/iu,
  /^(?:un|una|cada)\s+(?:[\p{L}\p{N}'’-]+\s+){0,4}(?:puede|pueden|debe|permite|ayuda)\b/iu,
  /^(?:context|background|for context|in context)\s*[:,—–-]/iu,
];

const ANAPHORA =
  /^(?:the (?:company|firm|brand|business|group|organi[sz]ation|corporation|startup|retailer|manufacturer|platform|project|repository|team)|this (?:company|firm|brand|business)|it|its|they|their|we|our|das unternehmen|die firma|l['’]entreprise|la société|la empresa|la compañía|a empresa|l['’]azienda|het bedrijf)\b/iu;

export function refersToTarget(text: string): boolean {
  return ANAPHORA.test(text.trim());
}

export function isDefinitional(text: string): boolean {
  const first = text.trim().split(/(?<=[.!?])\s/u)[0] ?? "";
  return DEFINITIONAL.some((pattern) => pattern.test(first));
}

export function hasGenericSubject(text: string): boolean {
  const first = text.trim();
  return GENERIC_SUBJECT.some((pattern) => pattern.test(first));
}

export function isConcrete(text: string): boolean {
  if (
    /\p{N}{2,}|\p{N}+(?:[.,]\p{N}+)?\s?(?:%|percent|per cent|million|billion|bn|m\b|k\b)/iu.test(
      text,
    )
  )
    return true;
  const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}&'’.-]*/gu) ?? [];
  return words
    .slice(1)
    .some((word) => /^\p{Lu}[\p{Ll}\p{N}]+\p{Lu}|^\p{Lu}{2,}\p{Ll}*\b/u.test(word));
}

export function sourceAboutTarget(source: SpecificitySource, target: SpecificityTarget): boolean {
  if (TARGET_OWNED_KINDS.has(source.kind)) return true;
  return mentionsTarget(
    `${source.title} ${decodeURIComponent(source.url).replace(/[_/]/g, " ")}`,
    target,
  );
}

export function classifyClaim(claim: ClaimLike, context: SpecificityContext): SpecificityVerdict {
  const { target } = context;
  const hasTarget = targetTerms(target).length > 0;
  const definitional = isDefinitional(claim.text);
  const genericSubject = hasGenericSubject(claim.text);
  if (hasTarget && mentionsTarget(claim.text, target)) return { label: "specific", reasons: [] };
  const cited = claim.citations
    .map((id) => context.sources.get(id))
    .filter((source): source is SpecificitySource => source !== undefined);
  const aboutTarget = cited.some((source) => sourceAboutTarget(source, target));
  if (hasTarget && aboutTarget && refersToTarget(claim.text))
    return { label: "specific", reasons: [] };
  const reasons: string[] = [];
  if (definitional) reasons.push("defines a generic concept");
  if (genericSubject) reasons.push("its subject is a generic concept, not the target");
  if (!hasTarget) {
    if (definitional || (genericSubject && !isConcrete(claim.text)))
      return { label: "generic", reasons };
    return { label: "specific", reasons: [] };
  }
  if (!aboutTarget && cited.length > 0)
    reasons.push("sourced only from general reference articles that are not about the target");
  if (definitional || genericSubject || (!aboutTarget && cited.length > 0))
    return { label: "generic", reasons };
  return { label: "specific", reasons: [] };
}

export interface SpecificitySplit<T extends ClaimLike> {
  specific: T[];
  context: T[];
  dropped: { claim: T; reasons: string[] }[];
}

export function splitBySpecificity<T extends ClaimLike>(
  claims: readonly T[],
  context: SpecificityContext,
  contextLines: number = SPECIFICITY_LIMITS.contextLines,
): SpecificitySplit<T> {
  const split: SpecificitySplit<T> = { specific: [], context: [], dropped: [] };
  for (const claim of claims) {
    const verdict = classifyClaim(claim, context);
    if (verdict.label === "specific") split.specific.push(claim);
    else if (split.context.length < contextLines) split.context.push(claim);
    else split.dropped.push({ claim, reasons: verdict.reasons });
  }
  return split;
}

export interface SpecificityScore {
  score: number | null;
  specific: number;
  generic: number;
  movedToContext: number;
  dropped: number;
}

export function specificityScore(
  specific: number,
  generic: number,
  movedToContext: number,
): SpecificityScore {
  const total = specific + generic;
  return {
    score: total === 0 ? null : Math.round((specific / total) * 1000) / 1000,
    specific,
    generic,
    movedToContext,
    dropped: Math.max(0, generic - movedToContext),
  };
}
