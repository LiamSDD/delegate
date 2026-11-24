export const GENERIC_PATTERNS: readonly { label: string; pattern: RegExp }[] = [
  {
    label: "use AI for customer support",
    pattern:
      /\b(use|deploy|add|implement|introduce|leverage)\s+(an?\s+)?(ai|llm|gpt|genai|chat ?bot|virtual assistant|ai assistant)s?\s+(for|to|in)\s+(handle\s+|answer\s+|automate\s+|improve\s+)?(customer\s+)?(support|service|inquiries|enquiries|questions|faqs?)\b/i,
  },
  {
    label: "chatbot for FAQs",
    pattern:
      /\bchat ?bots?\b[^.]{0,40}\b(faqs?|frequently asked|common questions|basic questions)\b/i,
  },
  {
    label: "automate email responses",
    pattern:
      /\bautomat(e|ed|ing)\s+(customer\s+)?(e-?mail|inbox)\s+(responses|replies|handling)\b/i,
  },
  {
    label: "generate marketing content",
    pattern:
      /\b(generate|write|create|draft)\s+(marketing|social[- ]media|blog|seo)\s+(content|posts|copy|articles)\b/i,
  },
  {
    label: "automate data entry",
    pattern: /\bautomat(e|ed|ing)\s+(manual\s+)?data[- ]entry\b/i,
  },
  {
    label: "summarise meetings",
    pattern: /\bsummari[sz](e|es|ing)\s+(meetings|calls|meeting notes)\b/i,
  },
  {
    label: "AI to improve efficiency",
    pattern:
      /\b(ai|machine learning|automation)\s+to\s+(improve|optimi[sz]e|streamline|enhance|boost)\s+(efficiency|productivity|operations|processes|workflows)\b/i,
  },
  { label: "sentiment analysis", pattern: /\bsentiment analysis\b/i },
  { label: "predictive analytics", pattern: /\bpredictive analytics\b/i },
];

const STOPWORDS = new Set(
  "the a an and or for with our your their this that these those from into onto over under about across more most less all any each every other such than then them they you we us it its is are was were be been being has have had do does did not no yes can will would should could may might must on in at by of to as per via new best top leading world global platform solution solutions service services team teams company companies customer customers business businesses product products data software tool tools work workflow workflows today help helps make makes get gets use uses using learn more read see now one two three".split(
    " ",
  ),
);

function tokens(text: string): string[] {
  return (
    text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}+.#-]*[\p{L}\p{N}+#]|[\p{L}\p{N}]/gu) ?? []
  );
}

export function specificTerms(quotes: readonly string[], companyName: string): Set<string> {
  const company = new Set(tokens(companyName));
  const terms = new Set<string>();
  for (const quote of quotes) {
    const words = quote.match(/[\p{L}\p{N}][\p{L}\p{N}+.#-]*[\p{L}\p{N}+#]|[\p{L}\p{N}]/gu) ?? [];
    for (const [index, word] of words.entries()) {
      const lower = word.toLowerCase();
      if (STOPWORDS.has(lower) || company.has(lower)) continue;
      const hasDigit = /\p{N}/u.test(word) && word.replace(/\D/g, "").length >= 2;
      const capitalised = index > 0 && /^\p{Lu}/u.test(word) && lower.length >= 3;
      const camel = /\p{Ll}\p{Lu}/u.test(word);
      if (hasDigit || capitalised || camel || lower.length >= 9) terms.add(lower);
    }
  }
  return terms;
}

export interface SpecificityInput {
  title: string;
  workflow: string;
  automation: string;
  evidence: readonly { text: string; citations: readonly string[] }[];
}

export interface SpecificityContext {
  companyName: string;
  quotes: ReadonlyMap<string, readonly string[]>;
}

export type SpecificityVerdict = { ok: true } | { ok: false; reasons: string[] };

export function matchGeneric(text: string): string | undefined {
  return GENERIC_PATTERNS.find((entry) => entry.pattern.test(text))?.label;
}

export function checkSpecificity(
  candidate: SpecificityInput,
  context: SpecificityContext,
): SpecificityVerdict {
  const reasons: string[] = [];
  const cited = [
    ...new Set(
      candidate.evidence.flatMap((entry) =>
        entry.citations.filter((citation) => context.quotes.has(citation)),
      ),
    ),
  ];
  if (cited.length === 0) reasons.push("cites no evidence about this company");
  const generic = matchGeneric(`${candidate.title}. ${candidate.workflow}`);
  if (generic !== undefined) {
    const terms = specificTerms(
      cited.flatMap((citation) => context.quotes.get(citation) ?? []),
      context.companyName,
    );
    const workflowTokens = new Set(tokens(`${candidate.workflow} ${candidate.automation}`));
    const tied = [...terms].some((term) => workflowTokens.has(term));
    if (!tied)
      reasons.push(`generic workflow ("${generic}") not tied to specifics from its cited evidence`);
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
