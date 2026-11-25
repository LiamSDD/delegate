import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { migrate } from "drizzle-orm/neon-serverless/migrator";

const ownerUrl = process.env.DATABASE_URL_UNPOOLED ?? "";
if (ownerUrl === "") {
  console.error("DATABASE_URL_UNPOOLED is empty. Run: sh scripts/neon-setup.sh");
  process.exit(1);
}

let parsed;
try {
  parsed = new URL(ownerUrl);
} catch {
  console.error("That does not look like a postgres:// connection string.");
  process.exit(1);
}
if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
  console.error("The connection string must start with postgres:// or postgresql://");
  process.exit(1);
}

const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);
const pool = new Pool({ connectionString: ownerUrl });

try {
  process.stdout.write("Running migrations…\n");
  await migrate(drizzle({ client: pool }), { migrationsFolder });

  const password = randomBytes(24).toString("hex");
  await pool.query(`ALTER ROLE delegate_app_login PASSWORD '${password}'`);

  const check = await pool.query(
    "select rolbypassrls, rolsuper from pg_roles where rolname = 'delegate_app_login'",
  );
  const row = check.rows[0];
  if (row === undefined || row.rolbypassrls || row.rolsuper) {
    throw new Error("delegate_app_login is missing or bypasses row-level security");
  }

  const host = parsed.hostname.includes("-pooler.")
    ? parsed.hostname
    : parsed.hostname.replace(/^([^.]+)\./, "$1-pooler.");
  const appUrl = new URL(ownerUrl);
  appUrl.username = "delegate_app_login";
  appUrl.password = password;
  appUrl.hostname = host;
  appUrl.searchParams.delete("channel_binding");
  appUrl.searchParams.set("sslmode", "require");

  process.stdout.write(
    "\nDone. Add these in Vercel → Project → Settings → Environment Variables:\n\n",
  );
  process.stdout.write(`DATABASE_URL=${appUrl.toString()}\n`);
  process.stdout.write(`DELEGATE_SESSION_SECRET=${randomBytes(32).toString("hex")}\n`);
  process.stdout.write(
    "\nCopy them now; they are not saved anywhere. Then clear this terminal (Cmd+K).\n",
  );
} catch (error) {
  console.error(`\nSetup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
