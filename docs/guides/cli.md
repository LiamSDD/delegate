# The `delegate` CLI

Start a mission from a terminal, watch it work, decide its plan and fetch what it produced. The CLI is a thin shell over the [REST API v1](./api.md) and the TypeScript SDK: it can do nothing a token cannot.

```console
$ delegate run repo-xray https://github.com/vercel/next.js --watch
Started repo-xray run 7d1d4f3e-2b8e-4c41-9e0f-3c2b1a0d9e8f on vercel/next.js
12:00:02  run      started · https://delegate.example/runs/7d1d4f3e-2b8e-4c41-9e0f-3c2b1a0d9e8f
12:00:09  plan     version 1, 4 steps
            1. clone: Clone the repository and index its files
            2. map: Map the architecture
            3. risks: Find risk hotspots and test gaps
            4. report: Write the report
            waiting for the plan to be approved
            approve: delegate approve-plan 7d1d4f3e-2b8e-4c41-9e0f-3c2b1a0d9e8f
            reject:  delegate reject-plan 7d1d4f3e-2b8e-4c41-9e0f-3c2b1a0d9e8f --reason "..."
            or edit and decide in the web app: https://delegate.example/runs/7d1d4f3e-...
12:00:41  plan     approved by guest
12:00:41  step     clone started
12:00:55  ok       clone: 4,112 files indexed
...
12:03:11  done     completed

Run completed in 3m 09s · 57,331 tokens, 41 tool calls
Deliverable: Architecture map (repo-xray)
  delegate artifacts get 7d1d4f3e-2b8e-4c41-9e0f-3c2b1a0d9e8f repo-map

Open: https://delegate.example/runs/7d1d4f3e-2b8e-4c41-9e0f-3c2b1a0d9e8f
```

## Run it

The CLI lives in `packages/cli`. From a checkout of the repository, with the monorepo's toolchain (Node 26 and pnpm):

```bash
pnpm install
pnpm delegate --help                       # from the repository root
node packages/cli/bin/delegate.mjs --help   # the same, from anywhere
```

To have `delegate` on your `PATH`, link the binary once:

```bash
ln -s "$PWD/packages/cli/bin/delegate.mjs" ~/.local/bin/delegate
```

The examples below assume that.

## Log in

Create an API token in the web app under **Settings → Connections**, then:

```bash
delegate login --api-url https://delegate.example
```

The CLI asks for the token and does not echo it. It checks the token against the API and stores it, with the deployment's URL, in `~/.config/delegate/config.json` (or `$XDG_CONFIG_HOME/delegate/config.json`, or the path in `DELEGATE_CONFIG`). The file is written with mode `600`; a directory the CLI has to create for it gets mode `700`. When the file is later found readable by other users, the CLI warns and tells you the `chmod` to run. The token is never printed, in output or in errors.

In scripts and CI, pipe the token or skip the file:

```bash
printf '%s' "$TOKEN" | delegate login --api-url https://delegate.example --token-stdin

export DELEGATE_URL=https://delegate.example
export DELEGATE_TOKEN=dlg_...      # overrides the stored token
```

Two guards worth knowing:

- A stored token is only ever sent to the deployment it was stored for. `--api-url` or `DELEGATE_URL` pointing somewhere else makes the command fail (exit 3) instead of sending the token there; log in to that deployment or set `DELEGATE_TOKEN`.
- Plain `http://` is accepted for `localhost` only.

`delegate logout` removes the file. To revoke the token itself, use **Settings → Connections**.

## Commands

| Command | What it does |
|---|---|
| `delegate login [--api-url <url>] [--token-stdin]` | Store a token |
| `delegate logout` | Remove the stored token |
| `delegate missions` | The missions and the input each takes |
| `delegate run <mission> <input> [--watch] [--json]` | Start a run |
| `delegate runs list [--status <s>] [--limit <n>] [--cursor <c>]` | List runs, newest first |
| `delegate runs get <run-id>` | Status, plan, pending decisions, steps, artifacts |
| `delegate runs events <run-id> [--after <seq>] [--follow]` | Print the event log; `--follow` streams until the run finishes |
| `delegate runs cancel <run-id>` | Cancel a run |
| `delegate approve-plan <run-id>` | Approve the proposed plan |
| `delegate reject-plan <run-id> [--reason <text>]` | Reject it |
| `delegate artifacts list <run-id>` | List a run's artifacts |
| `delegate artifacts get <run-id> <artifact-id> [--output <file>]` | Print or save one artifact's content |

Every command that talks to the API takes `--api-url <url>` and `--json`.

### `delegate run`

`<input>` is the mission's main input: a URL for most missions, the goal for `custom-goal` and `autopilot`.

```bash
delegate run company-xray acme.example --focus "pricing and packaging"
delegate run automation-audit acme.example --department Support
delegate run build-agent acme.example --goal "Answer support questions" --name "Acme helper" --opportunity opp-123 --parent-run run-456
delegate run custom-goal "Summarise the pricing page" --site acme.example
delegate run repo-xray https://github.com/vercel/next.js --ref canary
delegate run autopilot "Audit acme.example and build the most valuable assistant"
```

Without `--watch` the command prints the run id and its web URL and returns at once. With `--watch` it streams the run until it finishes:

- the **plan**, step by step, and, when the plan waits for a decision, the commands and the web URL to decide it
- **step progress**: `step … started`, then `ok` or `failed` with the step's summary
- **approvals** that need a person (`approve  needs a decision: …`), with the web URL where to decide them. Side effects such as connector tool calls and pull requests are approved in the web app, not from the CLI
- artifacts as they appear, policy blocks, model fallbacks and child runs of an Autopilot run
- at the end, the **deliverable**, the run's summary and its **web link**

Options:

| Option | Meaning |
|---|---|
| `--watch`, `-w` | Stream until the run finishes |
| `--json` | Print the run as JSON. With `--watch`: one JSON object per line, `{"event": …}` for each event and a final `{"run": …}` |
| `--verbose` | With `--watch`: also show tool calls and agent messages |
| `--timeout <seconds>` | With `--watch`: stop watching after this long (exit 12). The run keeps going |
| `--idempotency-key <key>` | Make the command safe to retry: the same key returns the same run for 24 hours |
| `--parent-run <run-id>` | `build-agent` only: the audit run the opportunity comes from |
| `--opportunity <id>` | `build-agent` only: the audit opportunity this run addresses |

Ctrl-C stops watching (exit 130) and does **not** cancel the run. Pick it up again with `delegate runs events <run-id> --follow`.

Text that comes from a run (step summaries, titles, error messages) may quote web pages. The CLI strips control characters and escape sequences from it before printing, so a page cannot repaint or reprogram your terminal.

### Scripting

```bash
RUN=$(delegate run repo-xray https://github.com/vercel/next.js --json | jq -r .id)
delegate approve-plan "$RUN"
if delegate runs events "$RUN" --follow --json > events.ndjson; then
  delegate artifacts get "$RUN" "$(delegate runs get "$RUN" --json | jq -r .deliverable.artifactId)" -o report.json
fi
```

With `--json`, results go to standard output and errors to standard error as one JSON object: `{"error":{"code","message","exitCode","requestId"}}`.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | The command succeeded. With `--watch` or `--follow`: the run completed |
| 1 | An unexpected error in the CLI |
| 2 | Unknown command or bad arguments |
| 3 | No token, or the token was refused (`401`, `403`) |
| 4 | The run, artifact or assistant does not exist for this token (`404`) |
| 5 | The API refused the request: validation, a conflict, a finished run (other `4xx`) |
| 6 | A request or run quota is used up (`429`) |
| 7 | Delegate could not be reached or failed (network error, `5xx`, unexpected response) |
| 10 | With `--watch` or `--follow`: the run failed |
| 11 | With `--watch` or `--follow`: the run was cancelled |
| 12 | `--timeout` elapsed first; the run is still going |
| 130 | Interrupted with Ctrl-C; a started run keeps going |

These are the exit codes of the binary. `pnpm delegate …` passes them through; `pnpm --filter @delegate/cli delegate …` does not (pnpm reports every failure of a filtered script as 1).

## Environment

| Variable | Meaning |
|---|---|
| `DELEGATE_TOKEN` | API token; overrides the stored one |
| `DELEGATE_URL` | The deployment; overridden by `--api-url` |
| `DELEGATE_CONFIG` | Path of the config file |
| `XDG_CONFIG_HOME` | Base directory of the default config path |

## Limits

- The CLI cannot approve side effects, edit plans, manage tokens or webhooks: those are in the web app.
- `--watch` follows one run. For an Autopilot run it shows child runs starting and finishing; follow a child in detail with `delegate runs events <child-run-id> --follow`.
- On Windows the config file's permissions are whatever the user profile gives it; the mode check is skipped there.
