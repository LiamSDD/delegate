const STOPWORDS: Record<string, readonly string[]> = {
  en: "the and of to in is for with that on are you your our we this from by it or".split(" "),
  de: "der die und das ist nicht mit für auf sie wir ein eine den von zu ihre unsere auch oder".split(
    " ",
  ),
  fr: "le la les et des est pour dans une un du que qui vous nous sur avec pas par votre".split(
    " ",
  ),
  es: "el la los las y de que en para con una un es por del su sus nuestro como más".split(" "),
  it: "il la e di che per con una un è del della dei le gli nostro sono come anche più".split(" "),
  nl: "de het een en van is voor met op niet wij onze je jouw zijn ook naar bij aan dat".split(" "),
  pt: "o a os as e de que para com uma um não do da dos seu sua nosso mais por".split(" "),
};
const MIN_HITS = 8;
const DOMINANCE = 1.5;

export function primaryLanguage(tag: string | undefined): string | undefined {
  const match = /^([a-z]{2,3})(?:[-_].*)?$/i.exec(tag?.trim() ?? "");
  return match?.[1]?.toLowerCase();
}

export function detectLanguage(text: string, declared?: string): string {
  const words = text
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter((word) => word !== "")
    .slice(0, 3_000);
  const counts = Object.entries(STOPWORDS).map(([language, list]) => {
    const set = new Set(list);
    return { language, hits: words.filter((word) => set.has(word)).length };
  });
  counts.sort((a, b) => b.hits - a.hits);
  const best = counts[0];
  const second = counts[1];
  if (best !== undefined && best.hits >= MIN_HITS && best.hits >= (second?.hits ?? 0) * DOMINANCE)
    return best.language;
  return primaryLanguage(declared) ?? "und";
}
