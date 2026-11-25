# ADR 0018: Platform interfaces (REST v1, OpenAPI, SDK, CLI, signed webhooks)

- Status: Accepted
- Date: 2026-11-25
- Implements: SPEC M6 "REST API, OpenAPI, TypeScript SDK, signed webhooks, CLI"; Demo B from a terminal

## Context

Everything the web UI does goes through unversioned routes under `/api` that were shaped for the browser: cookie sessions, same-origin checks, response bodies that changed whenever the UI needed something else. ADR 0014 added bearer tokens and an MCP server on top of the same functions. Integrators now need a surface they can build against: stable shapes, stable error codes, safe retries, and a way to be told when a run finishes instead of polling.

Constraints: Vercel Hobby serverless (300 s per invocation, `after()` for background work, no queue, no long-lived memory), Neon with FORCE row-level security and a non-superuser migration owner, $0 forever (ADR 0003), and the rule that security lives in code paths with tests.

## Decision

### 1. REST v1 is a typed layer over the existing functions

`/api/v1` accepts **only** bearer tokens (`resolve_api_token`, ADR 0014). Cookies are ignored there, so v1 has no ambient credential and needs no CSRF check; the browser keeps the unversioned routes. Every handler calls the same functions the UI and the MCP server call (`startRunForSession`, `getRunRecord` + `reviveOrSweep`, `buildRunView`, `readEvents`, `createRunEventStream`, `recordPlanDecision`, `artifactContent`, `findAssistant`), inside `withTenant(userId)`, so row-level security, per-user and per-network run quotas and policies are identical. A token is bound to one workspace: v1 also compares the record's workspace with the token's, because RLS is keyed by user and a user may belong to several workspaces.

Operations: create a run (every runnable mission and Autopilot), get a run, list runs (keyset cursor on `created_at, id`), read events (JSON pages with an `after` sequence cursor, or SSE on the same path when the client sends `Accept: text/event-stream`), cancel, approve or reject a plan, list and fetch artifacts, list assistants and chat with one. Approvals of side effects (ship, connector tool calls) are **not** in v1: they stay cookie-only, where the approver sees the full arguments.

One error envelope, `{ error: { code, message, requestId, issues? } }`, with a closed list of codes in the contract. Every response carries `X-Request-Id`; server logs carry the same id.

### 2. One contract, inside the SDK package

Request and response shapes are zod schemas in `packages/sdk/src/contract`, exported as `@delegate/sdk/contract`. The server imports them to validate input and to parse its own output (the response schema is an allowlist: a field that is not in the contract cannot leak), the SDK imports them to validate what it receives, and `buildOpenApiDocument()` turns the same operation table into OpenAPI 3.1 with `z.toJSONSchema(registry, { io: "input" })` (zod 4 emits JSON Schema 2020-12, which is what OpenAPI 3.1 uses). `GET /api/v1/openapi.json` serves it. The contract depends on zod only, so the SDK does not depend on the web app or the runtime; the lists it has to repeat (mission ids, event types, run statuses) are held to the runtime by parity tests. A test walks `app/api/v1/**/route.ts` and fails when a route and the document disagree in either direction.

### 3. Idempotency

`Idempotency-Key` is honoured on every v1 POST that returns JSON. The key is scoped to the token's workspace and stored with a SHA-256 of method, path and body. A replay within 24 hours returns the first response with `Idempotent-Replayed: true`; the same key with a different request is `422 idempotency_key_reused`; a concurrent duplicate is `409 idempotency_in_progress`. Only 2xx responses are stored: a failed request releases the key, so the client can retry it. The state machine is three `SECURITY DEFINER` functions (`idempotency_begin`, `_complete`, `_release`), because an insert-or-read race is easier to get right in one statement than in application code.

### 4. Rate-limit headers

v1 counts requests per token (1,200 per hour, the MCP budget) and reports `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` on every response, plus `Retry-After` on 429. The IETF RateLimit fields are still a moving draft (draft-12 renamed the parameters again), so v1 uses the widely deployed triple. The counter is in memory per instance, like the existing limiters; the run quotas behind it are unchanged.

### 5. SDK and CLI

`@delegate/sdk` gets a typed client for every operation, `for await` over run events (SSE over `fetch`, resuming from the last sequence), `waitForRun` with a timeout, and typed errors. No runtime dependency beyond zod; only web-platform APIs (`fetch`, streams, WebCrypto), so it runs in Node 20+ and browsers. The flat methods `packages/mcp-server` uses stay.

`delegate` (packages/cli) is a thin shell over the SDK: `login` (token read without echo, stored in a 0600 file, or `DELEGATE_TOKEN`), `run <mission> <input> [--watch] [--json]`, `runs list|get|events|cancel`, `approve-plan`, `reject-plan`, `artifacts list|get`. Exit codes are part of its contract.

### 6. Signed webhooks without a queue

- **Events:** `run.completed`, `run.failed`, `run.cancelled` (a `run.failed` event whose error code is `cancelled`) and `approval.requested`. The last one fires only when a human is actually awaited: an auto-approved plan or a pre-approved connector tool does not fire it, so the hook sits in the three approval waiters, not at event-append time.
- **Registration** is admin-only and cookie-only (`/settings/webhooks`). The URL goes through the fetch and connector guard (`validateConnectorUrl` with https required: no credentials, no IP literals, no local or metadata names, ports 80/443), and the host must resolve to public addresses only. Creating an endpoint is refused when `DELEGATE_ENCRYPTION_KEY` is missing.
- **Secret:** `whsec_` + 32 random bytes, shown once, stored with the connector `SecretBox` (AES-256-GCM, endpoint id as associated data). Tenant SQL cannot select the ciphertext column; only the delivery claim returns it.
- **Delivery:** a JSON body `{ id, type, created, apiVersion, data: { run, approval? } }`. Headers `Delegate-Timestamp` and `Delegate-Signature: v1=<hex HMAC-SHA256(secret, timestamp + "." + body)>`. Sent with `createPinnedFetch` (DNS checked at connect time), redirects are never followed, 10 s timeout. The verifier (in the SDK and as a dependency-free sample in the guide) rejects timestamps more than five minutes from now, which is what stops a replay.
- **Outbox:** the delivery rows are inserted in the transaction that appends the terminal event (in a savepoint, so a webhook failure cannot fail the run). The first attempt runs on the triggering request through `after()`; due retries are attempted opportunistically on later v1 traffic and settings visits of that workspace. Backoff: 1 min, 5 min, 30 min, 2 h, 8 h; after six attempts the delivery is `failed`. Claiming is a lease (`FOR UPDATE SKIP LOCKED`), so two instances do not send the same attempt, and delivery is at least once: receivers deduplicate on `id`.
- **Record:** status, attempts, last response code, next attempt time and at most 200 characters of the response, PII-redacted. No response body is kept.

### 7. Database (migration 0011)

`webhook_endpoints`: FORCE RLS, admin-only select and writes, as in 0007. `webhook_deliveries` and `idempotency_keys`: FORCE RLS, admin-only select, and **no** direct writes for `delegate_app`; they are written only by `SECURITY DEFINER` functions owned by `delegate_definer` that require operator or above in that workspace, the same floor as creating a run (a token resolves to its creator, who may since have become an operator).

## Consequences

- One shape for REST, SDK, CLI and OpenAPI; a contract change shows up as a type error on both sides and as a diff in the served document.
- v1 responses are parsed on the way out. A handler that drifts from the contract fails as `500 internal` with a request id rather than leaking an unlisted field.
- Without a queue, a retry needs traffic: a workspace that goes quiet after a failed first attempt gets its retry on its next request, not on a timer. The delivery log shows the next attempt time so this is visible. A cron or a queue can call the same claim function later.
- `approval.requested` deliveries are enqueued right after the approval row is opened, not in the same transaction; a crash in between loses the notification, never the approval.
- Rotating a secret invalidates the old one at once. The signature header already allows several `v1=` values, so overlapping secrets can be added without changing verifiers.
- Not done: webhook triggers for standing missions (SPEC D), endpoint auto-disable after repeated failures, shared rate-limit state across instances, and plan edits through v1 (the web UI keeps them).
