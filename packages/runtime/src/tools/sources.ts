import { z } from "zod";

export const SOURCE_KINDS = [
  "company_site",
  "wikipedia",
  "wikidata",
  "github",
  "feed",
  "connector",
] as const;
export const SourceKindSchema = z.enum(SOURCE_KINDS);
export type SourceKind = z.infer<typeof SourceKindSchema>;

export const SourceIdSchema = z.string().regex(/^S\d{1,4}$/);

export const SourceRecordSchema = z.object({
  sourceId: SourceIdSchema,
  url: z.url(),
  title: z.string(),
  fetchedAt: z.iso.datetime({ offset: true }),
  kind: SourceKindSchema,
});
export type SourceRecord = z.infer<typeof SourceRecordSchema>;

export interface SourceDocument {
  record: SourceRecord;
  text: string;
  hiddenText: string[];
}

export const SOURCE_TEXT_MAX_CHARS = 40_000;

export interface NewSource {
  url: string;
  title: string;
  kind: SourceKind;
  fetchedAt: string;
  text: string;
  hiddenText?: string[];
}

export class SourceStore {
  private readonly byId = new Map<string, SourceDocument>();
  private readonly byUrl = new Map<string, SourceDocument>();

  add(source: NewSource): { document: SourceDocument; created: boolean } {
    const key = normaliseUrlKey(source.url);
    const existing = this.byUrl.get(key);
    if (existing !== undefined) return { document: existing, created: false };
    const record = SourceRecordSchema.parse({
      sourceId: `S${this.byId.size + 1}`,
      url: source.url,
      title: source.title.trim() === "" ? source.url : source.title.trim().slice(0, 200),
      fetchedAt: source.fetchedAt,
      kind: source.kind,
    });
    const document: SourceDocument = {
      record,
      text: source.text.slice(0, SOURCE_TEXT_MAX_CHARS),
      hiddenText: source.hiddenText ?? [],
    };
    this.byId.set(record.sourceId, document);
    this.byUrl.set(key, document);
    return { document, created: true };
  }

  has(url: string): boolean {
    return this.byUrl.has(normaliseUrlKey(url));
  }

  get(sourceId: string): SourceDocument | undefined {
    return this.byId.get(sourceId);
  }

  all(): SourceDocument[] {
    return [...this.byId.values()];
  }
}

export function normaliseUrlKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol}//${parsed.host.replace(/^www\./, "")}${path}${parsed.search}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

export function snapshotContent(documents: readonly SourceDocument[]) {
  return {
    sources: documents.map((document) => ({
      ...document.record,
      text: document.text,
      hiddenText: document.hiddenText,
    })),
  };
}
