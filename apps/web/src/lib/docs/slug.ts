const NOT_KEPT = /[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu;

export function slugify(text: string): string {
  return text.trim().toLowerCase().replace(NOT_KEPT, "").replace(/ /g, "-");
}

export type Slugger = (text: string) => string;

export function createSlugger(): Slugger {
  const seen = new Map<string, number>();
  return (text) => {
    const base = slugify(text);
    let slug = base;
    let count = seen.get(base) ?? 0;
    while (seen.has(slug)) {
      count += 1;
      slug = `${base}-${count}`;
    }
    seen.set(base, count);
    seen.set(slug, seen.get(slug) ?? 0);
    return slug;
  };
}
