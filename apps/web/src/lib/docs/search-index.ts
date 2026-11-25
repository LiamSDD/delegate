import { DOC_SECTIONS } from "./manifest";
import { type DocsRegistry, loadDoc } from "./registry";
import type { SearchEntry } from "./search";

const MAX_HEADING_DEPTH = 3;

export function buildSearchIndex(registry: DocsRegistry): SearchEntry[] {
  const sectionTitles = new Map<string, string>(
    DOC_SECTIONS.map((section) => [section.id, section.title]),
  );
  return registry.entries.map((entry) => {
    const doc = loadDoc(entry);
    return {
      route: entry.route,
      title: entry.adr === null ? doc.title : `ADR ${entry.adr.number}: ${entry.adr.title}`,
      section: sectionTitles.get(entry.section) ?? entry.section,
      summary: entry.summary,
      headings: doc.markdown.headings
        .filter((heading) => heading.depth <= MAX_HEADING_DEPTH)
        .map((heading) => ({ id: heading.id, text: heading.text })),
    };
  });
}
