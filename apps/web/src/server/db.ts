import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDb, type Database } from "@delegate/db";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { z } from "zod";

import * as schema from "@delegate/db/schema";

export const APP_LOGIN_ROLE = "delegate_app_login";

export interface AppDatabase {
  readonly kind: "pglite" | "neon";
  readonly db: Database;
  close(): Promise<void>;
}

export class UnsafeConnectionError extends Error {
  override readonly name = "UnsafeConnectionError";
}

export function findRepoRoot(start: string): string {
  let current = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(current, "pnpm-workspace.yaml"))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`No pnpm-workspace.yaml above ${start}`);
    current = parent;
  }
}

export function resolveRepoRoot(
  candidates: readonly (string | undefined)[] = [
    process.env.DELEGATE_REPO_ROOT,
    process.cwd(),
    path.dirname(fileURLToPath(import.meta.url)),
  ],
): string {
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === "") continue;
    try {
      return findRepoRoot(candidate);
    } catch {
      continue;
    }
  }
  throw new Error("Could not locate the Delegate repository root (set DELEGATE_REPO_ROOT)");
}

const identityRow = z.object({
  session_user: z.string(),
  bypasses_rls: z.boolean(),
});

export async function connectionIdentity(
  db: Pick<Database, "execute">,
): Promise<{ sessionUser: string; bypassesRls: boolean }> {
  const result = await db.execute(
    sql`select session_user::text as session_user, (r.rolsuper or r.rolbypassrls) as bypasses_rls
        from pg_roles r where r.rolname = session_user`,
  );
  const row = identityRow.parse(z.object({ rows: z.array(z.unknown()) }).parse(result).rows[0]);
  return { sessionUser: row.session_user, bypassesRls: row.bypasses_rls };
}

async function assertSafeAppConnection(db: Database): Promise<void> {
  const identity = await connectionIdentity(db);
  if (identity.bypassesRls) {
    throw new UnsafeConnectionError(
      `The app connection logs in as ${identity.sessionUser}, which bypasses row-level security; use the ${APP_LOGIN_ROLE} role`,
    );
  }
}

export interface PgliteOptions {
  dataRoot?: string;
  migrationsFolder?: string;
}

export async function createPgliteAppDatabase(options: PgliteOptions = {}): Promise<AppDatabase> {
  const migrationsFolder =
    options.migrationsFolder ?? path.join(resolveRepoRoot(), "packages", "db", "migrations");
  let client: PGlite;
  if (options.dataRoot === undefined) {
    client = new PGlite({ extensions: { vector } });
  } else {
    mkdirSync(options.dataRoot, { recursive: true });
    writeFileSync(path.join(options.dataRoot, ".gitignore"), "*\n");
    client = new PGlite(path.join(options.dataRoot, "pglite"), { extensions: { vector } });
  }
  const pglite = drizzle({ client, schema });
  await migrate(pglite, { migrationsFolder });
  await pglite.execute(sql`set session authorization ${sql.identifier(APP_LOGIN_ROLE)}`);
  const db: Database = pglite;
  await assertSafeAppConnection(db);

  return {
    kind: "pglite",
    db,
    close: () => client.close(),
  };
}

export async function createNeonAppDatabase(databaseUrl: string): Promise<AppDatabase> {
  const db: Database = createDb(databaseUrl);
  await assertSafeAppConnection(db);
  return { kind: "neon", db, close: () => Promise.resolve() };
}

const databaseEnvSchema = z.object({
  DATABASE_URL: z.string().optional(),
});

export function createAppDatabaseFromEnv(env: Record<string, string | undefined>) {
  const parsed = databaseEnvSchema.parse(env);
  if (parsed.DATABASE_URL !== undefined && parsed.DATABASE_URL !== "") {
    return createNeonAppDatabase(parsed.DATABASE_URL);
  }
  return createPgliteAppDatabase({ dataRoot: path.join(resolveRepoRoot(), ".data") });
}

const holder = globalThis as typeof globalThis & {
  __delegateAppDatabase?: Promise<AppDatabase>;
};

export function getAppDatabase(): Promise<AppDatabase> {
  holder.__delegateAppDatabase ??= createAppDatabaseFromEnv(process.env).catch((error: unknown) => {
    delete holder.__delegateAppDatabase;
    throw error;
  });
  return holder.__delegateAppDatabase;
}
