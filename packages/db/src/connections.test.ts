import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createGuestWorkspace, withTenant } from "./client";
import { hashApiToken, isWellFormedApiToken, mintApiToken, resolveApiToken } from "./connections";
import {
  apiTokens,
  githubInstallations,
  mcpConnectors,
  members,
  workspaceSettings,
} from "./schema";
import { seedMember, seedUser } from "./testing/fixtures";
import { asAppLogin, createTestDb, expectDatabaseError, type TestDb } from "./testing/pglite";

let harness: Awaited<ReturnType<typeof createTestDb>>;
let db: TestDb;

beforeAll(async () => {
  harness = await createTestDb();
  db = harness.db;
});

afterAll(async () => {
  await harness.client.close();
});

const guest = () => asAppLogin(db, () => createGuestWorkspace(db));

async function storeToken(owner: { userId: string; workspaceId: string }, name = "laptop") {
  const minted = mintApiToken();
  await asAppLogin(db, () =>
    withTenant(db, owner.userId, (tx) =>
      tx.insert(apiTokens).values({
        workspaceId: owner.workspaceId,
        name,
        prefix: minted.prefix,
        tokenHash: minted.tokenHash,
      }),
    ),
  );
  return minted;
}

describe("api token minting", () => {
  it("mints a 32-byte base64url token with a lookup prefix and a SHA-256 hash", () => {
    const minted = mintApiToken(() => Buffer.alloc(32, 7));
    expect(minted.token).toMatch(/^dlg_[A-Za-z0-9_-]{43}$/);
    expect(minted.prefix).toBe(minted.token.slice(0, 12));
    expect(minted.tokenHash).toBe(hashApiToken(minted.token));
    expect(minted.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(isWellFormedApiToken(minted.token)).toBe(true);
    expect(isWellFormedApiToken(`${minted.token}x`)).toBe(false);
    expect(isWellFormedApiToken("Bearer abc")).toBe(false);
  });

  it("mints distinct tokens", () => {
    expect(mintApiToken().token).not.toBe(mintApiToken().token);
  });
});

describe("resolve_api_token()", () => {
  it("maps a valid token to its workspace and creator, and records last use", async () => {
    const owner = await guest();
    const minted = await storeToken(owner);
    const identity = await asAppLogin(db, () => resolveApiToken(db, minted.token));
    expect(identity).toMatchObject({ workspaceId: owner.workspaceId, userId: owner.userId });
    const [row] = await asAppLogin(db, () =>
      withTenant(db, owner.userId, (tx) =>
        tx
          .select({ lastUsedAt: apiTokens.lastUsedAt })
          .from(apiTokens)
          .where(eq(apiTokens.prefix, minted.prefix)),
      ),
    );
    expect(row?.lastUsedAt).toBeInstanceOf(Date);
  });

  it("rejects a token whose prefix matches but whose secret does not", async () => {
    const owner = await guest();
    const minted = await storeToken(owner);
    const forged = `${minted.prefix}${"A".repeat(minted.token.length - minted.prefix.length)}`;
    expect(await asAppLogin(db, () => resolveApiToken(db, forged))).toBeNull();
    expect(await asAppLogin(db, () => resolveApiToken(db, "not-a-token"))).toBeNull();
  });

  it("rejects revoked tokens and refuses to un-revoke them", async () => {
    const owner = await guest();
    const minted = await storeToken(owner);
    await asAppLogin(db, () =>
      withTenant(db, owner.userId, (tx) =>
        tx
          .update(apiTokens)
          .set({ revokedAt: new Date() })
          .where(eq(apiTokens.prefix, minted.prefix)),
      ),
    );
    expect(await asAppLogin(db, () => resolveApiToken(db, minted.token))).toBeNull();
    await asAppLogin(db, () =>
      expectDatabaseError(
        withTenant(db, owner.userId, (tx) =>
          tx.update(apiTokens).set({ revokedAt: null }).where(eq(apiTokens.prefix, minted.prefix)),
        ),
        /revoked and cannot be restored/,
      ),
    );
  });

  it("stops resolving once the creator is no longer an operator of the workspace", async () => {
    const owner = await guest();
    const colleague = await seedUser(db, `colleague-${crypto.randomUUID()}`);
    await seedMember(db, owner.workspaceId, colleague.id, "admin");
    const minted = await storeToken({ userId: colleague.id, workspaceId: owner.workspaceId });
    expect(await asAppLogin(db, () => resolveApiToken(db, minted.token))).not.toBeNull();
    await db.update(members).set({ role: "viewer" }).where(eq(members.userId, colleague.id));
    expect(await asAppLogin(db, () => resolveApiToken(db, minted.token))).toBeNull();
  });

  it("never exposes the stored hash to the app role", async () => {
    const owner = await guest();
    await storeToken(owner);
    await asAppLogin(db, () =>
      expectDatabaseError(
        withTenant(db, owner.userId, (tx) => tx.execute(sql`select token_hash from api_tokens`)),
        /permission denied/,
      ),
    );
  });

  it("refuses a token row written for another creator", async () => {
    const owner = await guest();
    const other = await guest();
    const minted = mintApiToken();
    await asAppLogin(db, () =>
      expectDatabaseError(
        withTenant(db, owner.userId, (tx) =>
          tx.execute(
            sql`insert into api_tokens (workspace_id, name, prefix, token_hash, created_by)
                values (${owner.workspaceId}, 'x', ${minted.prefix}, ${minted.tokenHash}, ${other.userId})`,
          ),
        ),
        /permission denied|row-level security/,
      ),
    );
  });
});

describe("connection tables are isolated per workspace", () => {
  it("hides tokens, connectors, installations and settings from other workspaces", async () => {
    const first = await guest();
    const second = await guest();
    await storeToken(first);
    await asAppLogin(db, () =>
      withTenant(db, first.userId, async (tx) => {
        await tx.insert(mcpConnectors).values({
          workspaceId: first.workspaceId,
          name: "tickets",
          url: "https://mcp.example/mcp",
        });
        await tx.insert(githubInstallations).values({
          workspaceId: first.workspaceId,
          installationId: 42,
          accountLogin: "acme",
          accountType: "Organization",
          repositorySelection: "all",
        });
        await tx.insert(workspaceSettings).values({
          workspaceId: first.workspaceId,
          preapprovedTools: [
            {
              tool: "mcp__tickets__comment",
              connectorId: "00000000-0000-4000-8000-000000000001",
              definitionSha256: "a".repeat(64),
            },
          ],
        });
      }),
    );
    const seen = await asAppLogin(db, () =>
      withTenant(db, second.userId, async (tx) => ({
        tokens: await tx
          .select({ id: apiTokens.id })
          .from(apiTokens)
          .where(eq(apiTokens.workspaceId, first.workspaceId)),
        connectors: await tx.select().from(mcpConnectors),
        installations: await tx.select().from(githubInstallations),
        settings: await tx.select().from(workspaceSettings),
      })),
    );
    expect(seen).toEqual({ tokens: [], connectors: [], installations: [], settings: [] });
  });

  it("rejects writes into another workspace", async () => {
    const first = await guest();
    const second = await guest();
    for (const write of [
      (userId: string) =>
        withTenant(db, userId, (tx) =>
          tx
            .insert(mcpConnectors)
            .values({ workspaceId: first.workspaceId, name: "evil", url: "https://mcp.example" }),
        ),
      (userId: string) =>
        withTenant(db, userId, (tx) =>
          tx.insert(githubInstallations).values({
            workspaceId: first.workspaceId,
            installationId: 7,
            accountLogin: "evil",
            accountType: "User",
            repositorySelection: "all",
          }),
        ),
      (userId: string) =>
        withTenant(db, userId, (tx) =>
          tx.insert(workspaceSettings).values({ workspaceId: first.workspaceId }),
        ),
    ]) {
      await asAppLogin(db, () => expectDatabaseError(write(second.userId), /row-level security/));
    }
  });

  it("keeps connector names to a safe slug", async () => {
    const owner = await guest();
    await asAppLogin(db, () =>
      expectDatabaseError(
        withTenant(db, owner.userId, (tx) =>
          tx.insert(mcpConnectors).values({
            workspaceId: owner.workspaceId,
            name: "Bad Name!",
            url: "https://x.example",
          }),
        ),
        /mcp_connectors_name_format/,
      ),
    );
  });
});
