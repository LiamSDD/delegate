import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { orgs, workspaces } from "./schema";
import { createTestDb, type TestDb } from "./testing/pglite";

describe("workspace retention", () => {
  let harness: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let orgId: string;

  beforeAll(async () => {
    harness = await createTestDb();
    db = harness.db;
    const [org] = await db
      .insert(orgs)
      .values({ name: "Retention", slug: "retention" })
      .returning();
    if (!org) throw new Error("org not created");
    orgId = org.id;
  });

  afterAll(async () => {
    await harness.client.close();
  });

  it("defaults demo workspaces to 7 days", async () => {
    const [row] = await db
      .insert(workspaces)
      .values({ orgId, name: "Demo", slug: "demo", isDemo: true })
      .returning();
    expect(row?.retentionDays).toBe(7);
  });

  it("leaves non-demo workspaces without retention", async () => {
    const [row] = await db
      .insert(workspaces)
      .values({ orgId, name: "Prod", slug: "prod" })
      .returning();
    expect(row?.retentionDays).toBeNull();
  });

  it("keeps an explicit demo retention", async () => {
    const [row] = await db
      .insert(workspaces)
      .values({ orgId, name: "Short demo", slug: "short-demo", isDemo: true, retentionDays: 1 })
      .returning();
    expect(row?.retentionDays).toBe(1);
  });

  it("applies the default when a workspace becomes a demo", async () => {
    const [created] = await db
      .insert(workspaces)
      .values({ orgId, name: "Later", slug: "later" })
      .returning();
    if (!created) throw new Error("workspace not created");
    const [updated] = await db
      .update(workspaces)
      .set({ isDemo: true })
      .where(eq(workspaces.id, created.id))
      .returning();
    expect(updated?.retentionDays).toBe(7);
  });
});
