# ADR 0014: Platform connections (MCP server, MCP client connectors, GitHub)

- Status: Accepted
- Date: 2026-11-25
- Pulls forward: SPEC M6 "MCP server, MCP client connectors"; Demo B step 1

## Context

People want to drive Delegate from the tools they already use (Claude Code, Codex, Cursor, any MCP client), give Delegate access to their own systems (their MCP servers, their GitHub repositories), and let routine work run without a human click when it stays inside policy. Each of these opens a new trust boundary:

1. **Client → Delegate.** A terminal process holds a credential that acts for a workspace, outside the browser and its same-origin protections.
2. **Delegate → connector.** A third-party MCP server returns content we do not control (tool output and tool *descriptions*), and some of its tools have side effects.
3. **Delegate → GitHub.** A visitor grants a GitHub App access to repositories; the binding between that installation and a Delegate workspace must not be forgeable.

Production runs on Vercel serverless functions (300 s cap, no sticky sessions) and Neon. Everything stays $0 and keyless by default (ADR 0003).

## Decision

### 1. Delegate as a remote MCP server (`/api/mcp`)

- **Transport:** Streamable HTTP from `@modelcontextprotocol/sdk` 1.32 (`WebStandardStreamableHTTPServerTransport`), **stateless** (`sessionIdGenerator: undefined`) with JSON responses (`enableJsonResponse: true`). Every POST builds a fresh `McpServer` + transport, handles one JSON-RPC message batch and is done. No session map, so any function instance can answer any request. GET (standalone SSE) and DELETE return 405; we send no server-initiated notifications.
- **Tools:** `start_mission`, `get_run`, `wait_for_run`, `approve_plan`, `reject_plan`, `list_runs`, `get_artifact`; one resource template `delegate://runs/{runId}/deliverable`. The tool set lives in `packages/mcp-server` behind a `DelegateBackend` interface, so the same definitions serve the remote endpoint (in-process backend over the server functions) and the local stdio server (backend over the REST API through `@delegate/sdk`).
- **`wait_for_run` is a bounded long-poll** (default 25 s, max 120 s), well under the 300 s function cap, polling the run record. Clients call it again until the run is terminal or a plan needs a decision. Runs started over MCP are ordinary runs: the event log drives the web UI live (ADR 0005).
- **Auth: per-workspace API tokens.** `dlg_` + base64url(32 random bytes). Stored as `prefix` (first 12 characters, unique, for lookup) and `sha256(token)` hex; the plaintext is shown once. Revocation sets `revoked_at`; `last_used_at` is updated at most once a minute. A `SECURITY DEFINER` function `resolve_api_token(prefix, hash)` (owned by `delegate_definer`) is the only path from a bearer token to an identity: it requires a matching hash, no revocation, and that the token's creator is still an operator+ member of the workspace. It returns `(token_id, workspace_id, user_id)`, and every request then runs through `withTenant(user_id)` exactly like a cookie session: same RLS, same per-user and per-IP rate limits. The REST routes accept the same bearer token (and skip the same-origin check only when a valid bearer token is presented, because bearer auth is not ambient and cannot be forged cross-site).
- **Setup snippets** for Claude Code, Codex, Cursor/VS Code and a generic client are generated on `/settings/connections` from the request's origin.

### 2. MCP client connectors

- A workspace admin adds a remote MCP server: Streamable HTTP URL plus an optional secret header (default `Authorization: Bearer …`).
- **URL guard:** `validateConnectorUrl` reuses the fetch hardening (ADR 0004): no credentials in URLs, no IP literals, no localhost / `.internal` / metadata names, ports 80/443 only, and `https:` only when `NODE_ENV=production`. Every connection goes through `createPinnedFetch`, so DNS is resolved and checked at connect time (no rebinding), and redirects are refused.
- **Secrets at rest:** AES-256-GCM (`node:crypto`), 12-byte random IV, 16-byte tag, key from `DELEGATE_ENCRYPTION_KEY` (64 hex characters, `openssl rand -hex 32`). The stored value is `v1.<iv>.<tag>.<ciphertext>` (base64url) with the connector id as additional authenticated data, so a ciphertext cannot be moved to another row. If the key is missing or malformed, adding a connector *with* a secret is refused with a clear message; secret-less connectors still work. Secrets are never returned to the browser, never logged and never sent to a model.
- **Tools become capabilities.** On connect we list tools and store `{name, description, readOnly, inputSchema}`. Each becomes a `RegisteredTool` named `mcp__<connector>__<tool>`:
  - `annotations.readOnlyHint === true` → capability `connector.read`. Runs under the normal policy engine, egress target = the connector host.
  - anything else → capability `connector.write`, which is in `SIDE_EFFECT_CAPABILITIES`: the fail-closed baseline returns `require_approval` for every call, whatever the workspace policies say.
- **Untrusted output.** Tool output never reaches a privileged model raw. It is capped (64 KB text, 20 s per call), stored as a PII-redacted artifact for the trace, and read by the quarantined reader (ADR 0002) with a connector extraction schema. The calling agent receives only the typed facts, each with a verbatim quote tagged `untrusted`, and the reader's `injectionSuspected` flag.
- **Untrusted descriptions (tool-description poisoning).** Remote tool descriptions are attacker-controllable text that would otherwise land in a privileged model's tool list. They are normalised (NFKC, control and format characters stripped), truncated to 200 characters and run through the same injection detector as page text; a tool whose name or description trips it is **not registered** and is shown as "withheld" in settings. Read-only classification never looks at the description.
- **Events:** each call emits `connector.call` `{toolCallId, connectorId, server, tool, ok, durationMs, bytes, truncated, summary}` with the summary PII-redacted. This is a new `RunEvent` type (event-type check updated in the migration).

### 3. Approvals and automation

- `executeToolCall` gains an optional `approvals` gate on the run context. When the policy decision is `require_approval`, the runtime emits `approval.requested`, asks the gate, emits `approval.resolved`, and runs the tool only on `approved`. Without a gate the call is refused as before.
- **Pre-approved connector tools.** `/settings/connections` stores per-workspace defaults in `workspace_settings`: `auto_approve_plans` (persisting the existing toggle) and `preapproved_tools` (a list of `mcp__…` tool names). The pre-approval gate approves exactly those names, as actor `{type: "system", id: "workspace-preapproval"}`, so the approval and the preceding `policy.decided: require_approval` are both in the event log and the audit view. Anything not on the list goes to the human approver, or is refused when there is none. Text in tool output cannot add to the list: the list is read from the database when the run starts.
- **Human approval for everything else.** In web runs the fallback gate is durable, like Ship-a-PR's: it opens an `approvals` row (step `tool`, action `{kind: "tool", approvalId, tool, argsSummary}`), the run page shows an approval card with the tool, the server and the PII-redacted arguments, and `POST /api/runs/{id}/tool-approval` (same origin, cookie session, operator+ through `resolve_approval()`) records the decision in `audit_log` as `tool.decision`. Unanswered requests are rejected after 10 minutes by `system:tool-approval-timeout`. A rejection is returned to the agent as a refused call; nothing runs.
- **Where connector tools are used.** The custom-goal mission adds a `use_connectors` step (`connector.read`, `connector.write`) when the workspace has connectors; a worker agent gets `ctx.connectorTools` and a versioned prompt (`custom-goal.connectors.v1.md`), and each connector result becomes a source of kind `connector` whose quarantined facts (quotes re-checked against the stored, redacted text) feed synthesis and the critic. The research gap-filler of the public-signal missions does not get connectors: those missions are about public sources, and mixing private workspace data into a public brief would blur its citations.
- **Resumed runs** reload the workspace's connectors and pre-approval list when the durable sweeper resumes a run (ADR 0007).

### 4. Connect GitHub (user authorisation of the GitHub App)

- "Connect GitHub" redirects to `https://github.com/login/oauth/authorize` with `client_id` and a `state` that is an HMAC (session secret) over `{workspaceId, userId, nonce, iat}`; the nonce is also set as an `HttpOnly; SameSite=Lax` cookie. The callback (`/api/github/callback`) accepts the code only when the state verifies, matches the cookie, belongs to the current session and is under 10 minutes old.
- The code is exchanged for a user access token, used within the request to call `GET /user/installations` (and `GET /user/installations/{id}/repositories` for `selected` installations), then dropped. **We do not store the user token.**
- The setup URL (`/api/github/setup`, GitHub's "Setup URL" with "Redirect on update") receives `installation_id`; it is trusted only after the same user-token check proves that the authorising user can access that installation. Then `{workspaceId, installationId, account, repositorySelection, repositories}` is upserted into `github_installations` (RLS).
- `findInstallationForRepo(workspaceId, owner, repo)` returns the installation whose account matches `owner` and which covers `repo` (all repositories, or the stored selection). Installation-token minting and PR creation belong to Ship-a-PR; this ADR only provides the binding.

## Consequences

- One credential type (API token) for MCP, REST, CLI and the stdio server; revocation is immediate because every request resolves the token in the database.
- Stateless MCP means no server→client notifications and no resumable streams; `wait_for_run` is the progress mechanism. That fits every listed client.
- Connector read-only classification trusts the server's own `readOnlyHint`. A malicious server that marks a write tool read-only can bypass the approval gate for its own tools; the workspace admin chose to add that server, and the egress allowlist still limits it to its own host. Recorded as residual risk T11 in `docs/SECURITY.md`.
- `repositories` for `selected` installations is a snapshot from the last setup redirect; GitHub calls the setup URL again on updates. Ship-a-PR must still handle a 404 from GitHub when the selection has shrunk.
- New tables: `api_tokens`, `mcp_connectors`, `github_installations`, `workspace_settings`, all with FORCE RLS and admin-only writes. One new event type, `connector.call`.
