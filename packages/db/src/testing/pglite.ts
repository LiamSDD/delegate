import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

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
