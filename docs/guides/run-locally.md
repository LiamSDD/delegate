# Run locally

One command starts the whole app with an embedded database. You need no accounts, no keys and no Docker.

## Requirements

- Node 26 or newer. The repository's `.nvmrc` says `26`.
- pnpm 12.23 or newer.

## Start it

```bash
pnpm install
pnpm dev
```

The web app is at http://localhost:3000. `pnpm install` also installs two git hooks: a secret scan and formatter before each commit, and the full check before each push.

## What starts

**The web app.** A Next.js app with the UI, the API routes and the MCP endpoint at `/api/mcp`. Missions run inside the same process.

**The database.** With no `DATABASE_URL`, the app opens an embedded PGlite database and keeps it under `.data/` at the repository root. That directory writes its own `.gitignore`. On start-up the app applies the real migrations from `packages/db/migrations`, then switches to the same non-owner login role that production uses. Row-level security, column grants and the append-only triggers therefore behave as they do on a hosted database. To start from an empty database, stop the server and delete `.data/`.

**Sessions.** Without `DELEGATE_SESSION_SECRET` the server signs session cookies with a random secret and prints a warning. Guest sessions then reset whenever the server restarts.

**Models.** With no provider keys, every role resolves to the keyless community endpoint in `config/models.json`. It needs nothing from you, and it is slow: the router limits it to 1.5 requests a minute with one in flight, so a mission takes minutes.

## Optional settings

Everything is configured through environment variables, and `.env.example` at the repository root lists every name with a comment. Next.js loads `apps/web/.env.local` in development. None of the variables is required locally.

| Variable | Effect |
|---|---|
| `NVIDIA_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `OPENROUTER_API_KEY`, `CLOUDFLARE_ACCOUNT_ID` with `CLOUDFLARE_API_TOKEN` | Adds that provider's free-tier models to the chains. Entries whose key is missing are skipped. |
| `ANTHROPIC_API_KEY` | Adds Claude as the last entry of each chain. |
| `DELEGATE_SESSION_SECRET` | Keeps guest sessions across restarts. At least 32 characters. |
| `DELEGATE_FAKE_RUNNER=1` | Replaces the runtime with a scripted runner, so the run page can be exercised without any model. Its runs are labelled "Simulated · no research, no model calls". Ignored in production. |
| `DELEGATE_OWNER_MODE=1` | Runs web missions with the owner audience. Ignored in production. |
| `DELEGATE_SHIP_A_PR=1` | Turns Ship-a-PR on. Locally the Engineer runs in a process sandbox, which is not an isolation boundary: use it only on repositories you trust. |
| `DELEGATE_ENCRYPTION_KEY` | Lets connectors store a secret. 64 hex characters from `openssl rand -hex 32`. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Exports traces over OTLP/HTTP. Unset means no export. |

To pass a variable for one session without a file, start only the web app:

```bash
DELEGATE_FAKE_RUNNER=1 pnpm --filter @delegate/web dev
```

## Check your changes

There is no hosted CI. The same gate runs locally and in the pre-push hook.

```bash
pnpm check        # typecheck, lint, tests, eval smoke and build across the monorepo
pnpm redteam      # the red-team suite; the attack success rate must be 0.0%
```

Scoped commands are faster while you work:

```bash
pnpm --filter @delegate/web typecheck
pnpm --filter @delegate/web lint
pnpm --filter @delegate/web exec vitest run src/lib/docs
pnpm --filter @delegate/runtime test
```

`pnpm smoke` sends one small tool-calling request to each configured model, so a provider that has gone away shows up before a demo does.

## Connect a local MCP client

The Connections page at http://localhost:3000/settings/connections creates tokens and shows client snippets with your local address. See [connect Claude Code, Codex, Cursor and VS Code](connect-mcp-clients.md).

## Next

- [Self-hosting](self-hosting.md): a hosted database, roles and the production environment.
- [Deploy on Vercel and Neon](../DEPLOY.md): the setup the live site uses.
