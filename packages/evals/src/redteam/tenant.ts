import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite, type Transaction } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { z } from "zod";

import { type TenantPayloadSchema } from "./schema";

interface Verdict {
  blockedBy: string;
  evidence: string[];
}

export const MIGRATIONS_PATH = fileURLToPath(new URL("../../../db/migrations", import.meta.url));
const APP_LOGIN_ROLE = "delegate_app_login";
const MARKER = "victim-only-7f3a";
const IDEMPOTENCY_KEY = "deploy-2026-11-25";
const REQUEST_HASH = "c".repeat(64);

const Journal = z.object({
  entries: z.array(z.object({ idx: z.number().int(), tag: z.string().regex(/^[\w-]+$/) })).min(1),
});

async function migratedDatabase(): Promise<PGlite> {
  const db = new PGlite({ extensions: { vector } });
  const journal = Journal.parse(
    JSON.parse(readFileSync(path.join(MIGRATIONS_PATH, "meta", "_journal.json"), "utf8")),
  );
  for (const entry of [...journal.entries].sort((a, b) => a.idx - b.idx)) {
    const text = readFileSync(path.join(MIGRATIONS_PATH, `${entry.tag}.sql`), "utf8");
    for (const statement of text.split("--> statement-breakpoint"))
      if (statement.trim() !== "") await db.exec(statement);
  }
  await db.exec(`set session authorization ${APP_LOGIN_ROLE}`);
  const who = await db.query<{ super: string }>("select current_setting('is_superuser') as super");
  if (who.rows[0]?.super !== "off")
    throw new Error("the tenant harness must not run its attacks as a superuser");
  return db;
}

interface Tenant {
  userId: string;
  workspaceId: string;
}

const TenantRow = z.object({ user_id: z.uuid(), workspace_id: z.uuid() });

async function guest(db: PGlite): Promise<Tenant> {
  return db.transaction(async (tx) => {
    await tx.exec("set local role delegate_app");
    const row = TenantRow.parse(
      (await tx.query("select user_id, workspace_id from create_guest_workspace()")).rows[0],
    );
    return { userId: row.user_id, workspaceId: row.workspace_id };
  });
}

function as<T>(db: PGlite, userId: string, work: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.exec("set local role delegate_app");
    await tx.query("select set_config('app.user_id', $1, true)", [userId]);
    return work(tx);
  });
}

type Attempt<T> = { refused: false; value: T } | { refused: true; code: string };

const DatabaseError = z.object({ code: z.string().regex(/^[0-9A-Z]{5}$/) });

async function attempt<T>(work: Promise<T>): Promise<Attempt<T>> {
  try {
    return { refused: false, value: await work };
  } catch (error) {
    const known = DatabaseError.safeParse(error);
    if (!known.success) throw error;
    return { refused: true, code: known.data.code };
  }
}

const IdRow = z.object({ id: z.uuid() });
const CountRow = z.object({ n: z.coerce.number().int() });

async function victimRun(db: PGlite, victim: Tenant): Promise<string> {
  return as(db, victim.userId, async (tx) => {
    const run = IdRow.parse(
      (
        await tx.query(
          "insert into runs (workspace_id, mission, input, budget) values ($1, 'company-xray', $2::jsonb, '{}'::jsonb) returning id",
          [victim.workspaceId, JSON.stringify({ url: `https://${MARKER}.example/` })],
        )
      ).rows[0],
    );
    await tx.query(
      "insert into run_events (run_id, workspace_id, type, payload, seq) values ($1, $2, 'agent.message', $3::jsonb, 1)",
      [run.id, victim.workspaceId, JSON.stringify({ text: MARKER })],
    );
    return run.id;
  });
}

async function count(tx: Transaction, statement: string, params: unknown[]): Promise<number> {
  return CountRow.parse((await tx.query(statement, params)).rows[0]).n;
}

async function readRun(db: PGlite): Promise<Verdict> {
  const victim = await guest(db);
  const attacker = await guest(db);
  const runId = await victimRun(db, victim);
  const evidence: string[] = [];
  const seen = await as(db, attacker.userId, async (tx) => ({
    run: await count(tx, "select count(*) as n from runs where id = $1", [runId]),
    events: await count(tx, "select count(*) as n from run_events where run_id = $1", [runId]),
    inWorkspace: await count(tx, "select count(*) as n from runs where workspace_id = $1", [
      victim.workspaceId,
    ]),
    marker: await count(
      tx,
      "select (select count(*) from runs where input::text like $1) + (select count(*) from run_events where payload::text like $1) as n",
      [`%${MARKER}%`],
    ),
    workspace: await count(tx, "select count(*) as n from workspaces where id = $1", [
      victim.workspaceId,
    ]),
  }));
  if (seen.run > 0) evidence.push("another workspace's token read the run by its id");
  if (seen.events > 0) evidence.push("another workspace's token read the run's events");
  if (seen.inWorkspace > 0) evidence.push("another workspace's token listed the victim's runs");
  if (seen.marker > 0) evidence.push("the victim's run content was readable across workspaces");
  if (seen.workspace > 0) evidence.push("the victim's workspace row was readable");
  const own = await as(db, victim.userId, (tx) =>
    count(tx, "select count(*) as n from run_events where run_id = $1", [runId]),
  );
  if (own !== 1) throw new Error("the victim cannot read its own run, so the case proves nothing");
  return { blockedBy: "rls:workspace-isolation", evidence };
}

async function writeRun(db: PGlite): Promise<Verdict> {
  const victim = await guest(db);
  const attacker = await guest(db);
  const runId = await victimRun(db, victim);
  const labels = new Set<string>(["rls:workspace-isolation"]);
  const evidence: string[] = [];
  const cancel = await attempt(
    as(db, attacker.userId, async (tx) => {
      const forged = await tx.query(
        "insert into run_events (run_id, workspace_id, type, payload, seq) values ($1, $2, 'run.failed', $3::jsonb, 2) returning id",
        [
          runId,
          victim.workspaceId,
          JSON.stringify({ error: { code: "cancelled", message: "cancelled by user" } }),
        ],
      );
      return forged.rows.length;
    }),
  );
  if (cancel.refused) labels.add("rls:insert-refused");
  else if (cancel.value > 0)
    evidence.push("a run.failed event was appended to another workspace's run");
  const relabelled = await attempt(
    as(db, attacker.userId, async (tx) => {
      const forged = await tx.query(
        "insert into run_events (run_id, workspace_id, type, payload, seq) values ($1, $2, 'run.failed', $3::jsonb, 2) returning id",
        [
          runId,
          attacker.workspaceId,
          JSON.stringify({ error: { code: "cancelled", message: "cancelled by user" } }),
        ],
      );
      return forged.rows.length;
    }),
  );
  if (relabelled.refused) labels.add("rls:insert-refused");
  else if (relabelled.value > 0)
    evidence.push(
      "an event for another workspace's run was accepted under the attacker's workspace",
    );
  const updated = await attempt(
    as(db, attacker.userId, async (tx) => {
      const result = await tx.query(
        "update runs set status = 'failed' where id = $1 returning id",
        [runId],
      );
      return result.rows.length;
    }),
  );
  if (!updated.refused && updated.value > 0) evidence.push("another workspace's run was updated");
  const after = await as(db, victim.userId, async (tx) => ({
    events: await count(tx, "select count(*) as n from run_events where run_id = $1", [runId]),
    planning: await count(
      tx,
      "select count(*) as n from runs where id = $1 and status = 'planning'",
      [runId],
    ),
  }));
  if (after.events !== 1) evidence.push("the victim's event log changed");
  if (after.planning !== 1) evidence.push("the victim's run status changed");
  return { blockedBy: [...labels].sort().join("+"), evidence };
}

const BeginRow = z.object({
  outcome: z.string(),
  stored_status: z.coerce.number().nullable(),
  stored_body: z.string().nullable(),
});

function begin(tx: Transaction, workspaceId: string) {
  return tx
    .query(
      "select outcome, stored_status, stored_body from idempotency_begin($1::uuid, $2, $3, 120, 86400)",
      [workspaceId, IDEMPOTENCY_KEY, REQUEST_HASH],
    )
    .then((result) => BeginRow.parse(result.rows[0]));
}

async function replayIdempotencyKey(db: PGlite): Promise<Verdict> {
  const victim = await guest(db);
  const attacker = await guest(db);
  const stored = JSON.stringify({ id: "run-of-the-victim", target: MARKER });
  await as(db, victim.userId, async (tx) => {
    const started = await begin(tx, victim.workspaceId);
    if (started.outcome !== "started") throw new Error("the victim's request did not start");
    await tx.query("select idempotency_complete($1::uuid, $2, $3, 201, $4)", [
      victim.workspaceId,
      IDEMPOTENCY_KEY,
      REQUEST_HASH,
      stored,
    ]);
  });
  const labels = new Set<string>();
  const evidence: string[] = [];

  const sameKey = await attempt(as(db, attacker.userId, (tx) => begin(tx, attacker.workspaceId)));
  if (sameKey.refused) throw new Error("the attacker could not use the key in its own workspace");
  if (sameKey.value.outcome === "started" && sameKey.value.stored_body === null)
    labels.add("idempotency:workspace-scope");
  else
    evidence.push(
      `the same Idempotency-Key in another workspace answered "${sameKey.value.outcome}" instead of starting a new request`,
    );
  if ((sameKey.value.stored_body ?? "").includes(MARKER))
    evidence.push("the victim's stored response was replayed to another workspace");

  const foreign = await attempt(as(db, attacker.userId, (tx) => begin(tx, victim.workspaceId)));
  if (foreign.refused) labels.add("idempotency:membership");
  else
    evidence.push(
      `a key of another workspace could be addressed directly and answered "${foreign.value.outcome}"`,
    );

  const direct = await attempt(
    as(db, attacker.userId, async (tx) => {
      const rows = await tx.query("select response_body from idempotency_keys");
      return rows.rows.length;
    }),
  );
  if (direct.refused) labels.add("idempotency:no-direct-read");
  else if (direct.value > 0) evidence.push("stored responses were readable with a plain select");
  else labels.add("idempotency:no-direct-read");

  const released = await attempt(
    as(db, attacker.userId, async (tx) => {
      await tx.query("select idempotency_release($1::uuid, $2, $3)", [
        victim.workspaceId,
        IDEMPOTENCY_KEY,
        REQUEST_HASH,
      ]);
    }),
  );
  if (released.refused) labels.add("idempotency:membership");
  const again = await as(db, victim.userId, (tx) => begin(tx, victim.workspaceId));
  if (again.outcome !== "replay" || again.stored_body !== stored)
    evidence.push("the victim's stored response was removed or changed by another workspace");
  return { blockedBy: [...labels].sort().join("+") || "none", evidence };
}

export async function runTenant(payload: z.infer<typeof TenantPayloadSchema>): Promise<Verdict> {
  const db = await migratedDatabase();
  try {
    switch (payload.attack) {
      case "read-run":
        return await readRun(db);
      case "write-run":
        return await writeRun(db);
      case "replay-idempotency-key":
        return await replayIdempotencyKey(db);
    }
  } finally {
    await db.close();
  }
}
