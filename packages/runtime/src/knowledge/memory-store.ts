import {
  type KnowledgeStore,
  type MemoryEntry,
  type MemoryStore,
  type PageRecord,
  type ScoredChunk,
  type StoredChunk,
  type StoredPage,
} from "./types";

const STOPWORDS = new Set(
  "a an and are as at be by can do does for from has have how i in is it its of on or our the this to was what when where which who why will with you your".split(
    " ",
  ),
);

export function lexicalTerms(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])
    .filter((word) => !STOPWORDS.has(word))
    .map((word) => word.replace(/(ing|ed|es|s)$/, "") || word);
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let left = 0;
  let right = 0;
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;
    dot += x * y;
    left += x * x;
    right += y * y;
  }
  return left === 0 || right === 0 ? 0 : dot / Math.sqrt(left * right);
}

interface MemoryChunk extends StoredChunk {
  collection: string;
  embedding?: number[];
}

export function createMemoryKnowledgeStore(): KnowledgeStore & { chunkCount(): number } {
  const pages = new Map<string, StoredPage & { collection: string }>();
  const chunks = new Map<string, MemoryChunk>();
  const key = (collection: string, url: string) => `${collection}\u0000${url}`;
  const visible = (collection: string) =>
    [...chunks.values()].filter((chunk) => chunk.collection === collection && !chunk.flagged);
  const strip = ({ collection: _collection, embedding: _embedding, ...rest }: MemoryChunk) => rest;
  return {
    chunkCount: () => chunks.size,
    getPage(collection, url) {
      const page = pages.get(key(collection, url));
      if (page === undefined) return Promise.resolve(null);
      const { collection: _collection, ...rest } = page;
      return Promise.resolve(rest);
    },
    putPage(record: PageRecord) {
      const existing = pages.get(key(record.collection, record.url));
      const documentId = existing?.documentId ?? crypto.randomUUID();
      for (const [id, chunk] of chunks) if (chunk.documentId === documentId) chunks.delete(id);
      for (const draft of record.chunks) {
        const chunkId = crypto.randomUUID();
        chunks.set(chunkId, {
          chunkId,
          documentId,
          collection: record.collection,
          url: record.url,
          title: record.title,
          ordinal: draft.ordinal,
          ...(draft.heading === undefined ? {} : { heading: draft.heading }),
          text: draft.text,
          tokenCount: draft.tokenCount,
          flagged: draft.flagged,
          hasEmbedding: false,
        });
      }
      const page = {
        collection: record.collection,
        documentId,
        url: record.url,
        title: record.title,
        contentHash: record.contentHash,
        bytes: record.bytes,
        links: record.links,
        chunkCount: record.chunks.length,
      };
      pages.set(key(record.collection, record.url), page);
      const { collection: _collection, ...rest } = page;
      return Promise.resolve(rest);
    },
    listChunks(collection) {
      return Promise.resolve(
        [...chunks.values()]
          .filter((chunk) => chunk.collection === collection)
          .sort((a, b) => a.url.localeCompare(b.url) || a.ordinal - b.ordinal)
          .map(strip),
      );
    },
    setEmbeddings(entries) {
      for (const entry of entries) {
        const chunk = chunks.get(entry.chunkId);
        if (chunk !== undefined) {
          chunk.embedding = entry.embedding;
          chunk.hasEmbedding = true;
        }
      }
      return Promise.resolve();
    },
    searchFullText({ collection, query, limit }) {
      const terms = new Set(lexicalTerms(query));
      const scored: ScoredChunk[] = [];
      for (const chunk of visible(collection)) {
        const words = lexicalTerms(`${chunk.heading ?? ""} ${chunk.text}`);
        let hits = 0;
        for (const word of words) if (terms.has(word)) hits += 1;
        if (hits === 0) continue;
        scored.push({ ...strip(chunk), score: hits / (1 + Math.log(1 + words.length)) });
      }
      return Promise.resolve(scored.sort((a, b) => b.score - a.score).slice(0, limit));
    },
    searchVector({ collection, embedding, limit }) {
      return Promise.resolve(
        visible(collection)
          .filter((chunk) => chunk.embedding !== undefined)
          .map((chunk) => ({ ...strip(chunk), score: cosine(embedding, chunk.embedding ?? []) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, limit),
      );
    },
  };
}

export function createMemoryMemoryStore(): MemoryStore & { entries: Map<string, unknown> } {
  const entries = new Map<string, unknown>();
  return {
    entries,
    read: () =>
      Promise.resolve([...entries.entries()].map(([key, value]): MemoryEntry => ({ key, value }))),
    write: ({ key, value }) => {
      entries.set(key, value);
      return Promise.resolve();
    },
  };
}
