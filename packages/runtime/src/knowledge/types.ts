import { z } from "zod";

export const ChunkDraftSchema = z.object({
  ordinal: z.number().int().nonnegative(),
  heading: z.string().max(200).optional(),
  text: z.string().min(1),
  tokenCount: z.number().int().nonnegative(),
  flagged: z.boolean(),
});
export type ChunkDraft = z.infer<typeof ChunkDraftSchema>;

export const PageRecordSchema = z.object({
  collection: z.string().min(1).max(200),
  url: z.url(),
  title: z.string().max(300),
  contentHash: z.string().min(1),
  fetchedAt: z.iso.datetime({ offset: true }),
  bytes: z.number().int().nonnegative(),
  links: z.array(z.string()).max(500),
  chunks: z.array(ChunkDraftSchema).max(400),
});
export type PageRecord = z.infer<typeof PageRecordSchema>;

export const StoredPageSchema = z.object({
  documentId: z.string().min(1),
  url: z.string().min(1),
  title: z.string(),
  contentHash: z.string(),
  bytes: z.number().int().nonnegative(),
  links: z.array(z.string()),
  chunkCount: z.number().int().nonnegative(),
});
export type StoredPage = z.infer<typeof StoredPageSchema>;

export const StoredChunkSchema = z.object({
  chunkId: z.string().min(1),
  documentId: z.string().min(1),
  url: z.string().min(1),
  title: z.string(),
  ordinal: z.number().int().nonnegative(),
  heading: z.string().optional(),
  text: z.string(),
  tokenCount: z.number().int().nonnegative(),
  flagged: z.boolean(),
  hasEmbedding: z.boolean(),
});
export type StoredChunk = z.infer<typeof StoredChunkSchema>;

export interface ScoredChunk extends StoredChunk {
  score: number;
}

export interface SearchParams {
  collection: string;
  query: string;
  limit: number;
}

export interface KnowledgeStore {
  getPage(collection: string, url: string): Promise<StoredPage | null>;
  putPage(page: PageRecord): Promise<StoredPage>;
  listChunks(collection: string): Promise<StoredChunk[]>;
  setEmbeddings(entries: readonly { chunkId: string; embedding: number[] }[]): Promise<void>;
  searchFullText(params: SearchParams): Promise<ScoredChunk[]>;
  searchVector(params: SearchParams & { embedding: number[] }): Promise<ScoredChunk[]>;
}

export const MemoryEntrySchema = z.object({
  key: z.string().min(1).max(100),
  value: z.unknown(),
  updatedAt: z.string().optional(),
});
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;

export interface MemoryStore {
  read(): Promise<MemoryEntry[]>;
  write(entry: { key: string; value: unknown; runId?: string }): Promise<void>;
}
