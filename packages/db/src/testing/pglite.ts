import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { z } from "zod";

import * as schema from "../schema";

export const migrationsFolder = fileURLToPath(new URL("../../migrations", import.meta.url));

export async function createTestDb() {
  const client = new PGlite({ extensions: { vector } });
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder });
  return { client, db };
}

export type TestDb = Awaited<ReturnType<typeof createTestDb>>["db"];

export function databaseErrorMessage(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join(" | ");
}

export async function expectDatabaseError(
  attempt: Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  let failure: unknown;
  try {
    await attempt;
  } catch (error: unknown) {
    failure = error;
  }
  if (failure === undefined) {
    throw new Error(
      `expected a database error matching ${pattern.source}, but the statement succeeded`,
    );
  }
  const message = databaseErrorMessage(failure);
  if (!pattern.test(message)) {
    throw new Error(`expected a database error matching ${pattern.source}, got: ${message}`);
  }
}

export const APP_LOGIN_ROLE = "delegate_app_login";

export async function asSessionRole<T>(db: TestDb, role: string, fn: () => Promise<T>): Promise<T> {
  await db.execute(sql`set session authorization ${sql.identifier(role)}`);
  try {
    return await fn();
  } finally {
    await db.execute(sql`set session authorization postgres`);
  }
}

export function asAppLogin<T>(db: TestDb, fn: () => Promise<T>): Promise<T> {
  return asSessionRole(db, APP_LOGIN_ROLE, fn);
}

export async function rowsOf<T extends z.ZodType>(
  row: T,
  result: Promise<unknown>,
): Promise<z.infer<T>[]> {
  return z.object({ rows: z.array(row) }).parse(await result).rows;
}
