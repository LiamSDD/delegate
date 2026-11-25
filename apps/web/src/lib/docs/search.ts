export const SEARCH_INDEX_PATH = "/docs/search-index.json";

export interface SearchHeading {
  id: string;
  text: string;
}

export interface SearchEntry {
  route: string;
  title: string;
  section: string;
  summary: string;
  headings: SearchHeading[];
}

export interface SearchHit {
  href: string;
  title: string;
  section: string;
  heading: string | null;
  score: number;
}

export function normaliseSearchText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function termScore(words: readonly string[], term: string): number {
  let best = 0;
  for (const word of words) {
    if (word === term) return 3;
    if (word.startsWith(term)) best = Math.max(best, 2);
    else if (term.length >= 3 && word.includes(term)) best = Math.max(best, 1);
  }
  return best;
}

function score(
  terms: readonly string[],
  primary: string,
  context: string,
  options: { contextWeight: number; needsPrimary: boolean },
): number {
  const primaryWords = normaliseSearchText(primary).split(" ");
  const contextWords = normaliseSearchText(context).split(" ");
  let total = 0;
  let inPrimary = 0;
  for (const term of terms) {
    const own = termScore(primaryWords, term);
    const borrowed = own > 0 ? 0 : termScore(contextWords, term) * options.contextWeight;
    if (own === 0 && borrowed === 0) return 0;
    if (own > 0) inPrimary += 1;
    total += own + borrowed;
  }
  if (options.needsPrimary && inPrimary === 0) return 0;
  return total / terms.length + inPrimary / (primaryWords.length + 4);
}

export function searchDocs(index: readonly SearchEntry[], query: string, limit = 10): SearchHit[] {
  const terms = normaliseSearchText(query)
    .split(" ")
    .filter((term) => term !== "");
  if (terms.length === 0) return [];
  const hits: (SearchHit & { order: number })[] = [];
  let order = 0;
  for (const entry of index) {
    const pageScore = score(terms, entry.title, `${entry.section} ${entry.summary}`, {
      contextWeight: 0.6,
      needsPrimary: false,
    });
    if (pageScore > 0)
      hits.push({
        href: entry.route,
        title: entry.title,
        section: entry.section,
        heading: null,
        score: pageScore * 1.5,
        order: order++,
      });
    for (const heading of entry.headings) {
      const headingScore = score(terms, heading.text, entry.title, {
        contextWeight: 0.4,
        needsPrimary: true,
      });
      if (headingScore > 0)
        hits.push({
          href: `${entry.route}#${encodeURIComponent(heading.id)}`,
          title: entry.title,
          section: entry.section,
          heading: heading.text,
          score: headingScore,
          order: order++,
        });
    }
  }
  return hits
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .map(({ order: _order, ...hit }) => hit);
}
