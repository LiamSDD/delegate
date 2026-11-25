import { apiTokens, mintApiToken, resolveApiToken, withTenant } from "@delegate/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import type { AppDatabase } from "./db";
import type { GuestSession } from "./session";

export const MAX_ACTIVE_TOKENS = 10;

export interface TokenSession extends GuestSession {
  tokenId: string;
}

export interface ApiTokenListing {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export const CreateTokenRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
});

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? "";
}

export function hasBearer(request: Request): boolean {
  return request.headers.get("authorization") !== null;
}

export async function authenticateBearer(
  app: AppDatabase,
  request: Request,
): Promise<TokenSession | null> {
  const token = bearerToken(request);
  if (token === null || token === "") return null;
  const identity = await resolveApiToken(app.db, token);
  return identity === null
    ? null
    : { userId: identity.userId, workspaceId: identity.workspaceId, tokenId: identity.tokenId };
}

export class TokenLimitError extends Error {
  override readonly name = "TokenLimitError";
}

export async function createApiToken(
  app: AppDatabase,
  session: GuestSession,
  name: string,
): Promise<{ token: string; listing: ApiTokenListing }> {
  const minted = mintApiToken();
  return withTenant(app.db, session.userId, async (tx) => {
    const active = await tx
      .select({ id: apiTokens.id })
      .from(apiTokens)
      .where(and(eq(apiTokens.workspaceId, session.workspaceId), isNull(apiTokens.revokedAt)));
    if (active.length >= MAX_ACTIVE_TOKENS)
      throw new TokenLimitError(`A workspace can have at most ${MAX_ACTIVE_TOKENS} active tokens.`);
    const [row] = await tx
      .insert(apiTokens)
      .values({
        workspaceId: session.workspaceId,
        name,
        prefix: minted.prefix,
        tokenHash: minted.tokenHash,
      })
      .returning({
        id: apiTokens.id,
        name: apiTokens.name,
        prefix: apiTokens.prefix,
        createdAt: apiTokens.createdAt,
      });
    if (row === undefined) throw new Error("token insert returned no row");
    return {
      token: minted.token,
      listing: {
        id: row.id,
        name: row.name,
        prefix: row.prefix,
        createdAt: row.createdAt.toISOString(),
        lastUsedAt: null,
        revokedAt: null,
      },
    };
  });
}

export async function listApiTokens(
  app: AppDatabase,
  session: GuestSession,
): Promise<ApiTokenListing[]> {
  const rows = await withTenant(app.db, session.userId, (tx) =>
    tx
      .select({
        id: apiTokens.id,
        name: apiTokens.name,
        prefix: apiTokens.prefix,
        createdAt: apiTokens.createdAt,
        lastUsedAt: apiTokens.lastUsedAt,
        revokedAt: apiTokens.revokedAt,
      })
      .from(apiTokens)
      .where(eq(apiTokens.workspaceId, session.workspaceId))
      .orderBy(desc(apiTokens.createdAt)),
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  }));
}

export async function revokeApiToken(
  app: AppDatabase,
  session: GuestSession,
  tokenId: string,
): Promise<boolean> {
  if (!z.uuid().safeParse(tokenId).success) return false;
  const rows = await withTenant(app.db, session.userId, (tx) =>
    tx
      .update(apiTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(apiTokens.id, tokenId),
          eq(apiTokens.workspaceId, session.workspaceId),
          isNull(apiTokens.revokedAt),
        ),
      )
      .returning({ id: apiTokens.id }),
  );
  return rows.length === 1;
}
