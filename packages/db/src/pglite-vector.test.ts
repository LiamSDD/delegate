import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { afterAll, describe, expect, it } from "vitest";

describe("in-process Postgres for tests", () => {
  const pg = new PGlite({ extensions: { vector } });

  afterAll(async () => {
    await pg.close();
  });

  it("loads pgvector and orders by cosine distance", async () => {
    await pg.exec("CREATE EXTENSION IF NOT EXISTS vector;");
    await pg.exec("CREATE TABLE probe (id int PRIMARY KEY, embedding vector(3));");
    await pg.exec("INSERT INTO probe VALUES (1, '[1,0,0]'), (2, '[0,1,0]'), (3, '[0.9,0.1,0]');");
    const result = await pg.query<{ id: number }>(
      "SELECT id FROM probe ORDER BY embedding <=> '[1,0,0]' LIMIT 2;",
    );
    expect(result.rows.map((row) => row.id)).toEqual([1, 3]);
  });
});
