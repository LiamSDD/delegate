# Self-hosting

This page documents the setups that are verified in this repository today. There are two: one machine with the embedded database, and Vercel with Neon. Where the code does not support something yet, the page says so.

## What you need

- Node 26 or newer and pnpm 12.23 or newer.
- A checkout of the repository. The app reads its migrations, prompt files and these docs from the checkout at run time.
- No container. This repository has no Dockerfile and no Compose file.

## Option 1: one machine, embedded database

This is the local setup from [Run locally](run-locally.md), built for production.

```bash
pnpm install
pnpm build
DELEGATE_SESSION_SECRET="$(openssl rand -base64 32)" pnpm --filter @delegate/web start
```

The server listens on port 3000. Keep the session secret stable between restarts, or every guest session is lost when the process restarts. In production the server refuses to sign sessions without one.

With no `DATABASE_URL`, data lives in an embedded PGlite database under `.data/` in the checkout. That has consequences:

- It is one process with one database connection. Run a single instance.
- The disk must persist. Back up `.data/` like any database directory.
- It does not fit serverless hosting, where the filesystem does not survive between invocations.

## Option 2: Vercel and Neon

This is how the live site runs, and [Deploy on Vercel and Neon](../DEPLOY.md) is the step-by-step guide. In short:

1. Create a Neon project and copy the owner connection string, with connection pooling off.
2. Run `sh scripts/neon-setup.sh` and paste the string at the hidden prompt. The script runs every migration, sets a random password on the app's login role, checks that the role cannot bypass row-level security, and writes the variables Vercel needs to a git-ignored file readable only by you.
3. Import the repository in Vercel with `apps/web` as the root directory, add the variables and deploy.

Later, `sh scripts/neon-migrate.sh` applies new migrations without touching the app login's password.

## The database

**Driver.** With `DATABASE_URL` set, the app connects through the Neon serverless driver, which speaks to Neon's endpoint over WebSockets. A plain Postgres server reached over TCP is not supported by the code at this commit: the driver would need a WebSocket proxy in front of it and configuration the app does not expose. The embedded database and Neon are the two supported targets.

**Extension.** The first migration runs `CREATE EXTENSION IF NOT EXISTS vector`, so the database must offer pgvector.

**Two connection strings, never shared.**

| Variable | Role | Used by |
|---|---|---|
| `DATABASE_URL_UNPOOLED` | The migration owner, over a direct connection | Migrations only: `pnpm db:migrate` and the two scripts above |
| `DATABASE_URL` | `delegate_app_login`, over the pooled connection | The running app |

The app checks its own login when it connects. If that login is a superuser or can bypass row-level security, the app refuses to start and names the role to use. The migration owner needs `CREATEROLE`, because the first migration creates the application roles. It does not need to be a superuser.

Migrations create the roles without passwords, so no secret lives in SQL. The setup script sets the app login's password for you. Done by hand, it is one statement run as the owner:

```sql
ALTER ROLE delegate_app_login PASSWORD '<from your secret manager>';
```

[Database and row-level security](../../packages/db/README.md) describes every role, the write paths that go through locked-down functions, and what the tests cover.

## Environment

`.env.example` at the repository root lists every variable with a comment.

| Variable | Needed | Purpose |
|---|---|---|
| `DELEGATE_SESSION_SECRET` | Always in production | Signs the guest session cookie. At least 32 characters. |
| `DATABASE_URL` | For a hosted database | The app login's pooled connection string. Unset means the embedded database. |
| `NVIDIA_API_KEY` and the other provider keys | Optional | Adds faster models to the chains. With no key at all the app uses the keyless endpoint, which is slow. |
| `DELEGATE_SHIP_A_PR`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_SLUG` | For Ship-a-PR | See [Connect GitHub and Ship-a-PR](github-and-ship-a-pr.md). |
| `DELEGATE_ENCRYPTION_KEY`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` | For connections | Connector secrets and Connect GitHub. |

`DELEGATE_FAKE_RUNNER` and `DELEGATE_OWNER_MODE` are ignored when `NODE_ENV=production`.

## What to know before you rely on it

- **Run length.** The route that starts runs declares a maximum duration of 300 seconds. A run that needs longer is checkpointed in the event log and resumes from its last finished step when its page, or its Autopilot parent, is next read. There is no job service and no cron in this repository, so a run nobody reads again waits. ADR 0007 explains the design.
- **Rate limits.** The per-guest and per-address run limits and the MCP request limit are counted in memory by each server process. With several instances they are per instance.
- **Retention.** Demo workspaces are limited to 7 days of retention by a database constraint, and the function `purge_expired_demo_runs()` deletes what has expired. Nothing in this repository schedules that function. Call it from your own scheduler with a login that has the `delegate_maintenance` role. See [privacy and retention](privacy-and-retention.md).
- **Where prompts go.** Model calls leave your server for the providers in `config/models.json`. Each entry records the provider's terms and the highest data classification it may receive.
- **Sandbox.** Ship-a-PR defaults to Vercel Sandbox in production and fails with a clear error if it is unavailable. The local process sandbox refuses to start in production.
- **Owner mode is off in production.** Every visitor is an anonymous guest in a demo workspace. Member accounts with roles and sign-in are not built yet.
