import { asc, cosineDistance, desc, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { withTenant } from "./client";
import { EMBEDDING_DIMENSIONS, chunks } from "./schema";
import { seedMember, seedUser, seedWorkspaceContent } from "./testing/fixtures";
import { createTestDb, type TestDb } from "./testing/pglite";

function embedding(weights: Record<number, number>): number[] {
  const values = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0);
  for (const [axis, weight] of Object.entries(weights)) {
    values[Number(axis)] = weight;
  }
  return values;
}

describe("hybrid search over chunks", () => {
  let harness: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let userId: string;
  let seeded: Awaited<ReturnType<typeof seedWorkspaceContent>>;

  beforeAll(async () => {
    harness = await createTestDb();
    db = harness.db;
    userId = (await seedUser(db, "searcher")).id;
    seeded = await seedWorkspaceContent(db, "search", userId);
    await seedMember(db, seeded.workspace.id, userId, "viewer");
    const outsider = (await seedUser(db, "outsider")).id;
    const foreign = await seedWorkspaceContent(db, "foreign", outsider);
    const base = { documentId: seeded.document.id, workspaceId: seeded.workspace.id };
    await db.insert(chunks).values([
      {
        ...base,
        ordinal: 1,
        text: "Invoices are reconciled by hand every month by the finance team.",
        embedding: embedding({ 0: 1 }),
      },
      {
        ...base,
        ordinal: 2,
        text: "The support desk triages tickets and escalates invoices disputes.",
        embedding: embedding({ 0: 0.6, 1: 0.8 }),
      },
      {
        ...base,
        ordinal: 3,
        text: "Engineering ships the mobile app every two weeks.",
        embedding: embedding({ 2: 1 }),
      },
    ]);
    await db.insert(chunks).values({
      documentId: foreign.document.id,
      workspaceId: foreign.workspace.id,
      ordinal: 1,
      text: "Foreign invoices reconciled monthly by hand.",
      embedding: embedding({ 0: 1 }),
    });
  });

  afterAll(async () => {
    await harness.client.close();
  });

  it("orders by cosine distance", async () => {
    const query = embedding({ 0: 0.9, 1: 0.1 });
    const rows = await withTenant(db, userId, (tx) =>
      tx
        .select({ ordinal: chunks.ordinal })
        .from(chunks)
        .where(sql`${chunks.embedding} is not null`)
        .orderBy(asc(cosineDistance(chunks.embedding, query)))
        .limit(3),
    );
    expect(rows.map((row) => row.ordinal)).toEqual([1, 2, 3]);
  });

  it("orders by full-text rank on the generated tsvector", async () => {
    const query = sql`websearch_to_tsquery('english', ${"invoices reconciled monthly"})`;
    const rows = await withTenant(db, userId, (tx) =>
      tx
        .select({ ordinal: chunks.ordinal })
        .from(chunks)
        .where(sql`${chunks.tsv} @@ ${query}`)
        .orderBy(desc(sql`ts_rank(${chunks.tsv}, ${query})`)),
    );
    expect(rows.map((row) => row.ordinal)).toEqual([1]);
    const looser = sql`websearch_to_tsquery('english', ${"invoices or reconciled"})`;
    const ranked = await withTenant(db, userId, (tx) =>
      tx
        .select({ ordinal: chunks.ordinal })
        .from(chunks)
        .where(sql`${chunks.tsv} @@ ${looser}`)
        .orderBy(desc(sql`ts_rank(${chunks.tsv}, ${looser})`)),
    );
    expect(ranked.map((row) => row.ordinal)).toEqual([1, 2]);
  });

  it("can serve the cosine ordering from the HNSW index", async () => {
    const plan = await db.transaction(async (tx) => {
      await tx.execute("set local enable_seqscan = off");
      return tx.execute(
        sql`explain select id from ${chunks} order by ${chunks.embedding} <=> ${JSON.stringify(embedding({ 0: 1 }))}::vector limit 3`,
      );
    });
    const lines = z
      .object({ rows: z.array(z.object({ "QUERY PLAN": z.string() })) })
      .parse(plan).rows;
    expect(lines.map((line) => line["QUERY PLAN"]).join("\n")).toMatch(/chunks_embedding_hnsw_idx/);
  });

  it("can serve full-text matches from the GIN index", async () => {
    const plan = await db.transaction(async (tx) => {
      await tx.execute("set local enable_seqscan = off");
      return tx.execute(
        sql`explain select id from ${chunks} where ${chunks.tsv} @@ websearch_to_tsquery('english', 'invoices')`,
      );
    });
    const lines = z
      .object({ rows: z.array(z.object({ "QUERY PLAN": z.string() })) })
      .parse(plan).rows;
    expect(lines.map((line) => line["QUERY PLAN"]).join("\n")).toMatch(/chunks_tsv_gin_idx/);
  });
});
