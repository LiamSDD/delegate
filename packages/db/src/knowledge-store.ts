import {
  AssistantRecordSchema,
  MemoryEntrySchema,
  PageRecordSchema,
  type AssistantRecord,
  type AssistantStore,
  type KnowledgeStore,
  type MemoryStore,
  type RunLease,
  type ScoredChunk,
  type StoredChunk,
  type StoredPage,
} from "@delegate/runtime";
import { and, asc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { type Database, withTenant } from "./client";
import { assistants, chunks, documents, memories, runs } from "./schema";

export interface TenantScope {
  userId: string;
  workspaceId: string;
}

const PageMetadataSchema = z.object({
  links: z.array(z.string()).default([]),
  bytes: z.number().int().nonnegative().default(0),
});

const MAX_QUERY_TERMS = 24;

export function fullTextQuery(text: string): string | undefined {
  const terms = [
    ...new Set(
      (text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).map((term) =>
        term.replace(/[^\p{L}\p{N}]/gu, ""),
      ),
    ),
  ]
    .filter((term) => term !== "")
    .slice(0, MAX_QUERY_TERMS);
  return terms.length === 0 ? undefined : terms.join(" | ");
}

function vectorLiteral(values: readonly number[]): string {
  return `[${values.map((value) => (Number.isFinite(value) ? value : 0)).join(",")}]`;
}

const chunkColumns = {
  chunkId: chunks.id,
  documentId: chunks.documentId,
  url: documents.sourceUrl,
  title: documents.title,
  ordinal: chunks.ordinal,
  heading: chunks.heading,
  text: chunks.text,
  tokenCount: chunks.tokenCount,
  flagged: chunks.flagged,
  hasEmbedding: sql<unknown>`${chunks.embedding} is not null`,
};

interface ChunkRow {
  chunkId: string;
  documentId: string;
  url: string | null;
  title: string;
  ordinal: number;
  heading: string | null;
  text: string;
  tokenCount: number;
  flagged: boolean;
  hasEmbedding: unknown;
}

function toChunk(row: ChunkRow): StoredChunk {
  return {
    chunkId: row.chunkId,
    documentId: row.documentId,
    url: row.url ?? "",
    title: row.title,
    ordinal: row.ordinal,
    ...(row.heading === null ? {} : { heading: row.heading }),
    text: row.text,
    tokenCount: row.tokenCount,
    flagged: row.flagged,
    hasEmbedding: z.boolean().parse(row.hasEmbedding),
  };
}

export function createDbKnowledgeStore(db: Database, scope: TenantScope): KnowledgeStore {
  const tenant = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db, scope.userId, fn);
  const inCollection = (collection: string): SQL | undefined =>
    and(eq(documents.workspaceId, scope.workspaceId), eq(documents.collection, collection));
  const visible = (collection: string): SQL | undefined =>
    and(inCollection(collection), eq(chunks.flagged, false));

  return {
    getPage: (collection, url) =>
      tenant(async (tx) => {
        const [row] = await tx
          .select({
            documentId: documents.id,
            url: documents.sourceUrl,
            title: documents.title,
            contentHash: documents.contentHash,
            metadata: documents.metadata,
            chunkCount: sql<unknown>`(select count(*)::int from ${chunks} where ${chunks.documentId} = ${documents.id})`,
          })
          .from(documents)
          .where(and(inCollection(collection), eq(documents.sourceUrl, url)));
        if (row === undefined) return null;
        const metadata = PageMetadataSchema.parse(row.metadata);
        return {
          documentId: row.documentId,
          url: row.url ?? url,
          title: row.title,
          contentHash: row.contentHash,
          bytes: metadata.bytes,
          links: metadata.links,
          chunkCount: z.coerce.number().parse(row.chunkCount),
        } satisfies StoredPage;
      }),
    putPage: (raw) =>
      tenant(async (tx) => {
        const page = PageRecordSchema.parse(raw);
        const [document] = await tx
          .insert(documents)
          .values({
            workspaceId: scope.workspaceId,
            collection: page.collection,
            sourceUrl: page.url,
            title: page.title,
            contentHash: page.contentHash,
            classification: "public",
            fetchedAt: new Date(page.fetchedAt),
            metadata: { links: page.links, bytes: page.bytes },
          })
          .onConflictDoUpdate({
            target: [documents.workspaceId, documents.collection, documents.sourceUrl],
            set: {
              title: page.title,
              contentHash: page.contentHash,
              fetchedAt: new Date(page.fetchedAt),
              metadata: { links: page.links, bytes: page.bytes },
            },
          })
          .returning({ id: documents.id });
        if (document === undefined) throw new Error(`Storing ${page.url} returned no document`);
        await tx.delete(chunks).where(eq(chunks.documentId, document.id));
        if (page.chunks.length > 0)
          await tx.insert(chunks).values(
            page.chunks.map((chunk) => ({
              documentId: document.id,
              workspaceId: scope.workspaceId,
              ordinal: chunk.ordinal,
              heading: chunk.heading ?? null,
              text: chunk.text,
              tokenCount: chunk.tokenCount,
              flagged: chunk.flagged,
            })),
          );
        return {
          documentId: document.id,
          url: page.url,
          title: page.title,
          contentHash: page.contentHash,
          bytes: page.bytes,
          links: page.links,
          chunkCount: page.chunks.length,
        };
      }),
    listChunks: (collection) =>
      tenant(async (tx) => {
        const rows = await tx
          .select(chunkColumns)
          .from(chunks)
          .innerJoin(documents, eq(documents.id, chunks.documentId))
          .where(inCollection(collection))
          .orderBy(asc(documents.sourceUrl), asc(chunks.ordinal));
        return rows.map(toChunk);
      }),
    setEmbeddings: (entries) =>
      tenant(async (tx) => {
        for (const entry of entries)
          await tx
            .update(chunks)
            .set({ embedding: entry.embedding })
            .where(and(eq(chunks.id, entry.chunkId), eq(chunks.workspaceId, scope.workspaceId)));
      }),
    searchFullText: ({ collection, query, limit }) => {
      const terms = fullTextQuery(query);
      if (terms === undefined) return Promise.resolve([]);
      return tenant(async (tx) => {
        const tsquery = sql`to_tsquery('english', ${terms})`;
        const rows = await tx
          .select({ ...chunkColumns, score: sql<unknown>`ts_rank_cd(${chunks.tsv}, ${tsquery})` })
          .from(chunks)
          .innerJoin(documents, eq(documents.id, chunks.documentId))
          .where(and(visible(collection), sql`${chunks.tsv} @@ ${tsquery}`))
          .orderBy(sql`ts_rank_cd(${chunks.tsv}, ${tsquery}) desc`)
          .limit(limit);
        return rows.map((row): ScoredChunk => ({
          ...toChunk(row),
          score: z.coerce.number().parse(row.score),
        }));
      });
    },
    searchVector: ({ collection, embedding, limit }) =>
      tenant(async (tx) => {
        const target = sql`${vectorLiteral(embedding)}::vector`;
        const rows = await tx
          .select({ ...chunkColumns, distance: sql<unknown>`${chunks.embedding} <=> ${target}` })
          .from(chunks)
          .innerJoin(documents, eq(documents.id, chunks.documentId))
          .where(and(visible(collection), sql`${chunks.embedding} is not null`))
          .orderBy(sql`${chunks.embedding} <=> ${target}`)
          .limit(limit);
        return rows.map((row): ScoredChunk => ({
          ...toChunk(row),
          score: 1 - z.coerce.number().parse(row.distance),
        }));
      }),
  };
}

export function createDbAssistantStore(db: Database, scope: TenantScope): AssistantStore {
  return {
    save: (raw) =>
      withTenant(db, scope.userId, async (tx) => {
        const record: AssistantRecord = AssistantRecordSchema.parse(raw);
        const runId = z.uuid().safeParse(record.runId);
        const values = {
          name: record.name,
          collection: record.collection,
          config: record.config,
          evals: record.evals ?? null,
          gaps: record.gaps ?? null,
        };
        await tx
          .insert(assistants)
          .values({
            id: record.id,
            workspaceId: scope.workspaceId,
            runId: runId.success ? runId.data : null,
            ...values,
          })
          .onConflictDoUpdate({ target: assistants.id, set: { ...values, updatedAt: new Date() } });
      }),
    get: (id) =>
      withTenant(db, scope.userId, async (tx) => {
        const parsedId = z.uuid().safeParse(id);
        if (!parsedId.success) return null;
        const [row] = await tx
          .select()
          .from(assistants)
          .where(
            and(eq(assistants.id, parsedId.data), eq(assistants.workspaceId, scope.workspaceId)),
          );
        if (row === undefined) return null;
        return AssistantRecordSchema.parse({
          id: row.id,
          ...(row.runId === null ? {} : { runId: row.runId }),
          name: row.name,
          collection: row.collection,
          config: row.config,
          ...(row.evals === null ? {} : { evals: row.evals }),
          ...(row.gaps === null ? {} : { gaps: row.gaps }),
        });
      }),
  };
}

export const WORKSPACE_MEMORY_AGENT = "workspace-memory";

export function createDbMemoryStore(db: Database, scope: TenantScope): MemoryStore {
  return {
    read: () =>
      withTenant(db, scope.userId, async (tx) => {
        const rows = await tx
          .select({ key: memories.key, value: memories.value, createdAt: memories.createdAt })
          .from(memories)
          .where(and(eq(memories.workspaceId, scope.workspaceId), isNull(memories.runId)))
          .orderBy(asc(memories.key));
        return rows.map((row) =>
          MemoryEntrySchema.parse({
            key: row.key,
            value: row.value,
            updatedAt: row.createdAt.toISOString(),
          }),
        );
      }),
    write: ({ key, value }) =>
      withTenant(db, scope.userId, async (tx) => {
        const entry = MemoryEntrySchema.parse({ key, value });
        await tx
          .insert(memories)
          .values({
            workspaceId: scope.workspaceId,
            runId: null,
            key: entry.key,
            value: entry.value ?? null,
            createdByAgent: WORKSPACE_MEMORY_AGENT,
          })
          .onConflictDoUpdate({
            target: [memories.workspaceId, memories.runId, memories.key],
            set: { value: entry.value ?? null, createdAt: new Date() },
          });
      }),
  };
}

export function createDbRunLease(
  db: Database,
  options: { userId: string; runId: string; owner: string; ttlMs: number },
): RunLease {
  const runId = z.uuid().parse(options.runId);
  const owner = z.string().min(1).max(200).parse(options.owner);
  const ttlMs = z.number().int().positive().parse(options.ttlMs);
  const claim = () =>
    withTenant(db, options.userId, async (tx) => {
      const rows = await tx
        .update(runs)
        .set({
          leaseOwner: owner,
          leaseExpiresAt: sql`now() + (${ttlMs} * interval '1 millisecond')`,
        })
        .where(
          and(
            eq(runs.id, runId),
            sql`(${runs.leaseOwner} is null or ${runs.leaseOwner} = ${owner} or ${runs.leaseExpiresAt} < now())`,
          ),
        )
        .returning({ id: runs.id });
      return rows.length === 1;
    });
  return {
    ttlMs,
    acquire: claim,
    renew: () =>
      withTenant(db, options.userId, async (tx) => {
        const rows = await tx
          .update(runs)
          .set({ leaseExpiresAt: sql`now() + (${ttlMs} * interval '1 millisecond')` })
          .where(and(eq(runs.id, runId), eq(runs.leaseOwner, owner)))
          .returning({ id: runs.id });
        return rows.length === 1;
      }),
    release: () =>
      withTenant(db, options.userId, async (tx) => {
        await tx
          .update(runs)
          .set({ leaseOwner: null, leaseExpiresAt: null })
          .where(and(eq(runs.id, runId), eq(runs.leaseOwner, owner)));
      }),
  };
}
