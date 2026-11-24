# @delegate/db

Drizzle schema, migrations and row-level security for Delegate. Postgres enforces tenant isolation, append-only logs and approval rules itself, so a bug in the app cannot turn into a cross-tenant read or a forged audit trail.

## Roles and connection strings

The migration owner and the app never share a connection. The app logs in as a role that owns nothing and can only act after `SET ROLE delegate_app`.

| Role | Login | Purpose |
|---|---|---|
| migration owner (e.g. Neon `neondb_owner`) | yes | Runs migrations and owns every table. RLS is `FORCE`d, so this role sees **no rows** through normal queries. It never serves requests. |
| `delegate_app_login` | yes | The app's connection identity. `NOINHERIT`, member only of `delegate_app`, owns nothing. On its own it has no table privileges. `RESET ROLE` drops it back to zero access, not to the owner. |
| `delegate_app` | no | Carries every grant and RLS policy for tenant traffic. `withTenant()` does `SET LOCAL ROLE delegate_app` and sets `app.user_id` per transaction. |
| `delegate_definer` | no | Owns the `SECURITY DEFINER` functions. It has narrow grants plus `*_definer_*` policies on the tables those functions touch. Not a table owner, and no login role is a member. |
| `delegate_system` | no | Marker role. `record_audit()` entries with `actor_type` `system` or `agent` only succeed when the **session** login is a member. Grant it to the background worker's login, never to `delegate_app_login`. |
| `delegate_maintenance` | no | The only role (besides the owner) allowed to call `purge_expired_demo_runs()`. Grant it to the cron login. |

Environment variables, for the root `.env.example`:

```bash
# App traffic: pooled URL for delegate_app_login (never the owner).
DATABASE_URL=postgres://delegate_app_login:<password>@<pooled-host>/<db>?sslmode=require
# Migrations: direct URL for the owner role. Read by drizzle.config.ts.
DATABASE_URL_UNPOOLED=postgres://<owner>:<password>@<direct-host>/<db>?sslmode=require
```

`drizzle.config.ts` reads `DATABASE_URL_UNPOOLED` and falls back to `DATABASE_URL`. Always set `DATABASE_URL_UNPOOLED` when migrating; the app login cannot run migrations.

Migrations create the roles without passwords, so nothing secret lives in SQL. After the first migration, as the owner:

```sql
ALTER ROLE delegate_app_login PASSWORD '<from your secret manager>';
-- optional, for the background worker and the retention cron:
CREATE ROLE delegate_worker_login LOGIN NOINHERIT PASSWORD '...';
GRANT delegate_app, delegate_system TO delegate_worker_login;
CREATE ROLE delegate_cron_login LOGIN NOINHERIT PASSWORD '...';
GRANT delegate_maintenance TO delegate_cron_login;
```

The migration owner needs `CREATEROLE` (Neon's owner role has it). Migration `0000` grants `delegate_definer` to the owner so that it can hand function ownership to that role.

## Write paths that bypass plain DML

| Operation | How | Rules enforced in the database |
|---|---|---|
| Resolve an approval | `resolveApproval(tx, id, "approved" \| "rejected")` → `resolve_approval()` | `delegate_app` has no `UPDATE` on `approvals`. Caller must be operator+ and a human (`member`/`guest`, not `agent`). The approval must be `pending`. `resolved_by = app.user_id` and `resolved_at = now()`. An operator cannot **approve** an action on a run they created; owners and admins can, and anyone allowed to resolve may **reject**. Writes an `approval.approved`/`approval.rejected` audit row. A trigger keeps `action`, `run_id`, `step_id`, `workspace_id` and `requested_at` immutable, and stops resolved approvals from changing or re-opening, even for the owner. |
| Write the audit log | `recordAudit(tx, entry)` → `record_audit()` | No direct `INSERT` for `delegate_app`. `actor_id` always comes from `app.user_id`. `user` entries need workspace membership. `agent` entries need `delegate_system` on the session login and an agent identity. `system` entries need `delegate_system` and store `actor_id = null`. `policy_id`/`approval_id` must belong to the same workspace. |
| Add usage to a run | `addRunUsage(tx, runId, usage)` → `add_run_usage()` | Non-negative deltas only; operator+. A trigger rejects any decrease of `runs.totals`. |
| Read a user's email | `visibleUserEmail(tx, userId)` → `visible_user_email()` | `users.email` has no column grant for `delegate_app`. Returns the email to the user themselves and to owners/admins of a workspace the user belongs to; otherwise `null`. |
| Append a run event | `appendRunEvent(tx, event)` | Validates `{type, payload, stepId, agentId}` against `@delegate/runtime`'s `RunEventSchema`. Locks the run row with `SELECT ... FOR UPDATE` under RLS (operator+ only) before computing `seq`. A caller who cannot write the run gets `RunNotWritableError` and takes no lock. |
| Create a guest tenant | `createGuestWorkspace(db)` → `create_guest_workspace()` | Takes no arguments. Runs as `delegate_app` (no `app.user_id` needed) and inserts an anonymous `guest` user, an org with a random slug, a demo workspace (7-day retention) and the owner membership in one transaction. `delegate_app` still has no `INSERT` on `users`, `orgs` or `workspaces`; only `delegate_definer` does, through `*_definer_insert` policies (migration `0003`). Rate limiting stays in the app (per guest and per IP). |
| Purge demo data | `purgeExpiredDemoRuns(conn)` → `purge_expired_demo_runs()` | See retention below. |

`runs` column privileges for `delegate_app`: `INSERT` plus `UPDATE (status, started_at, finished_at)`. The insert policy forces `created_by = app.user_id` (also the column default) and zero `totals`. A trigger keeps `budget`, `mission`, `input`, lineage and `prompt_versions` immutable for everyone.

`members`: a trigger keeps at least one owner per workspace. It blocks deleting or demoting the last owner, including through `DELETE FROM users`. It does not block deleting the workspace itself.

## Retention

Demo workspaces keep data for at most 7 days. `CHECK (NOT is_demo OR retention_days <= 7)` holds, and the trigger defaults demo workspaces to 7. `purge_expired_demo_runs()`:

1. Collects demo runs older than `retention_days`, plus every fork of them. A fork cannot be replayed without its parent's events, so `runs_parent_run_fk` cascades.
2. Deletes demo-workspace `audit_log` rows older than `retention_days`, and rows tied to approvals of the doomed runs. **Decision:** demo audit rows follow the same 7-day retention as the demo data, because the UI promises demo runs are deleted after 7 days. Non-demo audit rows are never purged.
3. Deletes the runs. `run_events`, `artifacts`, `approvals` and `memories` go by `ON DELETE CASCADE`.

The append-only triggers on `run_events` and `audit_log` allow a `DELETE` only when the transaction-local setting `delegate.retention_purge = on` is set **and** the call stack (`PG_CONTEXT`) is inside `purge_expired_demo_runs()`. A session that sets the setting itself, owner included, is still rejected. `UPDATE` and `TRUNCATE` are never allowed. Deleting a workspace that still has run events or audit rows is therefore refused by the append-only triggers. There is no workspace-deletion path yet; demo workspaces shed their data through the purge.

## Run status and JSON columns

- `run_status` is exactly the runtime's `RunStatus`, so `runs.status` can always be rebuilt from `foldRun(run_events)`. There is no `pending`/`cancelled`: no runtime event produces them.
- `approval_status`: `pending | approved | rejected | expired`, matching the runtime's `approval.resolved` resolutions.
- `document_classification` matches `@delegate/policy`'s `DATA_CLASSIFICATIONS` (adds `restricted`).
- `runs.budget` is `{ maxTokens?, maxMicroUsd? }` (runtime `BudgetLimits`). `runs.prompt_versions` is `{ [slug]: positive int }` (evals `PromptVersionsSchema`).
- Parity tests in `src/enum-parity.test.ts` and `src/event-types-parity.test.ts` fail when either side drifts.

## Tests

`pnpm --filter @delegate/db test` runs every migration into an in-process PGlite (Postgres 19) per file. Tests that matter for production identity use `asAppLogin()`, which does `SET SESSION AUTHORIZATION delegate_app_login`, so `RESET ROLE` and `session_user` checks behave as they do behind a real login. Limits of PGlite:

- One connection, so no real concurrency. The 20-append test checks ordering only. The row lock is asserted through `pg_locks` and `xmax` instead. The last-owner advisory lock and the `FOR UPDATE` in `resolve_approval()` are not exercised under contention.
- The harness connects as superuser `postgres`, which bypasses RLS and passes every `pg_has_role` check. Fixtures rely on that. Anything that depends on the session identity must be tested through `asAppLogin()`/`asSessionRole()`.
- `RESET SESSION AUTHORIZATION` does not restore `postgres` in PGlite, so the helpers use `SET SESSION AUTHORIZATION postgres`.
- Neon-specific behaviour (role creation through the console, `neon_superuser`, PgBouncer transaction pooling with `SET LOCAL`) is not covered.

## Commands

```bash
pnpm --filter @delegate/db db:generate   # after schema changes; custom SQL lives in 0000, 0002 and the tail of 0003
pnpm --filter @delegate/db db:check      # drizzle-kit check: journal and snapshots consistent
pnpm --filter @delegate/db db:migrate    # uses DATABASE_URL_UNPOOLED (owner)
```
