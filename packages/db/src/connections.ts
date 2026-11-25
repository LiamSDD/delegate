import { createHash, randomBytes } from "node:crypto";

import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "./client";

export const API_TOKEN_PREFIX = "dlg_";
export const API_TOKEN_LOOKUP_CHARS = 12;
const API_TOKEN_PATTERN = /^dlg_[A-Za-z0-9_-]{43}$/;

export interface MintedApiToken {
  token: string;
  prefix: string;
  tokenHash: string;
}

export function hashApiToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function mintApiToken(random: (size: number) => Buffer = randomBytes): MintedApiToken {
  const token = `${API_TOKEN_PREFIX}${random(32).toString("base64url")}`;
  return { token, prefix: token.slice(0, API_TOKEN_LOOKUP_CHARS), tokenHash: hashApiToken(token) };
}

export function isWellFormedApiToken(token: string): boolean {
  return API_TOKEN_PATTERN.test(token);
}

export interface ApiTokenIdentity {
  tokenId: string;
  workspaceId: string;
  userId: string;
}

const identityRow = z.object({ token_id: z.uuid(), workspace_id: z.uuid(), user_id: z.uuid() });

export async function resolveApiToken(
  db: Database,
  token: string,
): Promise<ApiTokenIdentity | null> {
  if (!isWellFormedApiToken(token)) return null;
  const prefix = token.slice(0, API_TOKEN_LOOKUP_CHARS);
  const tokenHash = hashApiToken(token);
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local role delegate_app`);
    const result = await tx.execute(
      sql`select token_id, workspace_id, user_id from resolve_api_token(${prefix}, ${tokenHash})`,
    );
    const [row] = z.object({ rows: z.array(identityRow) }).parse(result).rows;
    if (row === undefined) return null;
    return { tokenId: row.token_id, workspaceId: row.workspace_id, userId: row.user_id };
  });
}
