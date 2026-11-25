import type { LinkTargets } from "./links";
import {
  ADR_DIRECTORY,
  ADR_INDEX_SLUG,
  DOC_MANIFEST,
  DOC_SECTIONS,
  type DocSectionId,
  GUIDES_DIRECTORY,
} from "./manifest";
import { parseMarkdown, type ParsedMarkdown } from "./markdown";
import { listRepoDir, readRepoText } from "./repo";

export const DOCS_ROOT = "/docs";

export interface AdrMeta {
  number: string;
  title: string;
  status: string | null;
  date: string | null;
}

export interface DocEntry {
  slug: readonly string[];
  route: string;
  source: string;
  section: DocSectionId;
  label: string;
  summary: string;
  adr: AdrMeta | null;
}

export interface LoadedDoc {
  entry: DocEntry;
  title: string;
  markdown: ParsedMarkdown;
}

export interface NavItem {
  route: string;
  label: string;
  prefix?: string;
  children?: NavItem[];
}

export interface NavSection {
  id: DocSectionId;
  title: string;
  items: NavItem[];
}

export interface DocsRegistry extends LinkTargets {
  entries: readonly DocEntry[];
  adrs: readonly DocEntry[];
  bySlug(slug: readonly string[]): DocEntry | undefined;
  bySource(source: string): DocEntry | undefined;
  adrByNumber(number: string): DocEntry | undefined;
  neighbours(entry: DocEntry): { previous: DocEntry | null; next: DocEntry | null };
  navigation(): NavSection[];
}

export function docRoute(slug: readonly string[]): string {
  return slug.length === 0 ? DOCS_ROOT : `${DOCS_ROOT}/${slug.join("/")}`;
}

const ADR_FILE = /^(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

export function parseAdrMeta(number: string, source: string): AdrMeta {
  const heading = /^#\s+(.+?)\s*$/m.exec(source)?.[1] ?? `ADR ${number}`;
  const status = /^-\s+Status:\s*(.+?)\s*$/m.exec(source)?.[1] ?? null;
  const date = /^-\s+Date:\s*(\d{4}-\d{2}-\d{2})\s*$/m.exec(source)?.[1] ?? null;
  return {
    number,
    title: heading.replace(/^ADR\s+\d{4}\s*[:.-]\s*/i, ""),
    status,
    date,
  };
}

function adrEntries(): DocEntry[] {
  return listRepoDir(ADR_DIRECTORY).flatMap((file) => {
    const number = ADR_FILE.exec(file)?.[1];
    if (number === undefined) return [];
    const source = `${ADR_DIRECTORY}/${file}`;
    const adr = parseAdrMeta(number, readRepoText(source));
    const slug = [...ADR_INDEX_SLUG, file.replace(/\.md$/, "")];
    return [
      {
        slug,
        route: docRoute(slug),
        source,
        section: "architecture" as const,
        label: adr.title,
        summary: [`ADR ${number}`, adr.status, adr.date]
          .filter((part) => part !== null)
          .join(" · "),
        adr,
      },
    ];
  });
}

function slugKey(slug: readonly string[]): string {
  return slug.join("/");
}

export function buildDocsRegistry(): DocsRegistry {
  const adrs = adrEntries();
  const entries: DocEntry[] = [];
  for (const item of DOC_MANIFEST) {
    entries.push({ ...item, route: docRoute(item.slug), adr: null });
    if (slugKey(item.slug) === slugKey(ADR_INDEX_SLUG)) entries.push(...adrs);
  }
  return registryOf(entries);
}

export function registryOf(entries: readonly DocEntry[]): DocsRegistry {
  const adrs = entries.filter((entry) => entry.adr !== null);
  const bySlugKey = new Map(entries.map((entry) => [slugKey(entry.slug), entry]));
  const bySourcePath = new Map(entries.map((entry) => [entry.source, entry]));
  const byAdrNumber = new Map(adrs.map((entry) => [entry.adr?.number ?? "", entry]));
  const aliases = new Map<string, string>([
    [ADR_DIRECTORY, docRoute(ADR_INDEX_SLUG)],
    [GUIDES_DIRECTORY, DOCS_ROOT],
    ["docs", DOCS_ROOT],
  ]);

  return {
    entries,
    adrs,
    bySlug: (slug) => bySlugKey.get(slugKey(slug)),
    bySource: (source) => bySourcePath.get(source),
    adrByNumber: (number) => byAdrNumber.get(number),
    routeForSource: (source) => bySourcePath.get(source)?.route ?? aliases.get(source),
    neighbours(entry) {
      const index = entries.indexOf(entry);
      return {
        previous: index > 0 ? (entries[index - 1] ?? null) : null,
        next: index === -1 ? null : (entries[index + 1] ?? null),
      };
    },
    navigation() {
      return DOC_SECTIONS.map((section) => ({
        id: section.id,
        title: section.title,
        items: entries
          .filter((entry) => entry.section === section.id && entry.adr === null)
          .map((entry): NavItem => {
            const item: NavItem = { route: entry.route, label: entry.label };
            if (slugKey(entry.slug) === slugKey(ADR_INDEX_SLUG))
              item.children = adrs.map((adr) => ({
                route: adr.route,
                label: adr.label,
                prefix: adr.adr?.number ?? "",
              }));
            return item;
          }),
      }));
    },
  };
}

const cacheable = process.env.NODE_ENV !== "development";
let cachedRegistry: DocsRegistry | undefined;
const cachedDocs = new Map<string, LoadedDoc>();

export function docsRegistry(): DocsRegistry {
  if (!cacheable) return buildDocsRegistry();
  cachedRegistry ??= buildDocsRegistry();
  return cachedRegistry;
}

export function loadDoc(entry: DocEntry): LoadedDoc {
  const cached = cacheable ? cachedDocs.get(entry.source) : undefined;
  if (cached !== undefined) return cached;
  const markdown = parseMarkdown(readRepoText(entry.source));
  const loaded: LoadedDoc = { entry, title: markdown.title ?? entry.label, markdown };
  if (cacheable) cachedDocs.set(entry.source, loaded);
  return loaded;
}
