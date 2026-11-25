# Connect Claude Code, Codex, Cursor and VS Code

Delegate is a remote MCP server at `/api/mcp`. Add it to your coding agent once, then ask the agent to "run a company X-ray on acme.com with Delegate". The run streams live in the web app, under the same policies, approvals, quotas and audit log as a run you start in the browser.

## 1. Create a token

Open https://delegate-beryl.vercel.app/settings/connections and choose **Create token**. Give it a name you will recognise later, such as "Claude Code on my laptop".

- The token is `dlg_` followed by 32 random bytes. It is shown once. Delegate stores a SHA-256 hash and a 12-character lookup prefix, so it cannot show the token again.
- A token acts for one workspace, with the rights of the member who created it.
- A workspace can have at most 10 active tokens. **Revoke** is immediate and permanent, because every request resolves the token in the database.
- A token can start and read runs and decide on plans. It cannot change settings: tokens, connectors, GitHub and automation defaults need the browser session.

## 2. Add Delegate to your client

The snippets below are the ones the Connections page shows for the live site. On your own deployment the page shows them with your address. After you create a token, the page fills the token into the snippets that take it directly.

### Claude Code

Run in a terminal, then check the connection with `/mcp` inside Claude Code.

```bash
claude mcp add --transport http delegate https://delegate-beryl.vercel.app/api/mcp \
  --header "Authorization: Bearer <your-delegate-token>"
```

### Codex

Add to `~/.codex/config.toml`, then export `DELEGATE_TOKEN` in the shell that starts Codex.

```toml
[mcp_servers.delegate]
url = "https://delegate-beryl.vercel.app/api/mcp"
bearer_token_env_var = "DELEGATE_TOKEN"

# export DELEGATE_TOKEN=<your-delegate-token>
```

### Cursor

Add to `~/.cursor/mcp.json`, or to `.cursor/mcp.json` in a project. The token is read from the `DELEGATE_TOKEN` environment variable.

```json
{
  "mcpServers": {
    "delegate": {
      "url": "https://delegate-beryl.vercel.app/api/mcp",
      "headers": {
        "Authorization": "Bearer ${env:DELEGATE_TOKEN}"
      }
    }
  }
}
```

### VS Code

Add to `.vscode/mcp.json`. VS Code prompts for the token once and stores it securely.

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "delegate-token",
      "description": "Delegate API token",
      "password": true
    }
  ],
  "servers": {
    "delegate": {
      "type": "http",
      "url": "https://delegate-beryl.vercel.app/api/mcp",
      "headers": {
        "Authorization": "Bearer ${input:delegate-token}"
      }
    }
  }
}
```

### Any other MCP client

The endpoint speaks Streamable HTTP, stateless, with JSON responses. Send the token on every request.

```text
URL:        https://delegate-beryl.vercel.app/api/mcp
Transport:  Streamable HTTP (POST only, no session)
Header:     Authorization: Bearer <your-delegate-token>
```

### Clients that only speak stdio

A thin local server in this repository talks to the REST API with the same token.

```bash
DELEGATE_URL=https://delegate-beryl.vercel.app DELEGATE_TOKEN=<your-delegate-token> \
  pnpm --filter @delegate/mcp-server stdio
```

The stdio server offers the same tools. Its `start_mission` starts `company-xray`, `automation-audit` and `build-agent` only. Use the HTTP endpoint for the other missions.

## 3. Use it

| Tool | What it does |
|---|---|
| `start_mission` | Starts `company-xray`, `automation-audit`, `build-agent`, `custom-goal` or `repo-xray`. Returns the run id and the web URL where the run streams live. |
| `start_autopilot` | Starts an Autopilot run from a goal and an optional company URL. |
| `get_run` | Status, step summary and, when finished, the deliverable. For an Autopilot run it lists the children with their status. |
| `wait_for_run` | Long-polls until the run finishes, needs a plan decision, or the timeout passes: 25 seconds by default, 120 at most. Call it again while the run is still working. |
| `approve_plan` | Approves the plan a run is waiting on. |
| `reject_plan` | Rejects it, with an optional reason. The run stops. |
| `list_runs` | The most recent runs in the workspace, 50 at most. |
| `get_artifact` | Reads one artifact of a run: a deliverable, a source snapshot or a connector output. |

Finished deliverables are also MCP resources at `delegate://runs/{runId}/deliverable`.

A typical exchange is `start_mission`, then `wait_for_run` in a loop. If the workspace does not approve plans automatically, `wait_for_run` returns as soon as the plan needs a decision, and your agent calls `approve_plan` or `reject_plan`. Ship-a-PR is not a tool here: a pull request is approved on the run page, where the diff is.

## Limits

- The transport is stateless. Every POST builds a fresh server object and handles one batch of messages, so there are no sessions, no server-sent notifications and no resumable streams. GET and DELETE answer 405. `wait_for_run` is the progress mechanism.
- Each token may make 1,200 MCP requests an hour. Starting a run also counts against the same run quotas as the browser: 5 an hour per user and 20 an hour per network address on the public demo. These counters live in memory on each server instance.
- A tool result carries at most 60,000 characters of deliverable. Longer ones are cut with a pointer to `get_artifact` and the resource.

## What the token does not bypass

Every MCP request runs through the same tenant isolation as a cookie session: the token resolves to a workspace and a user, and row-level security applies from there. Plans still need approval unless the workspace approves them automatically, and side effects still ask a person. The design and its threat model are in ADR 0014.
