# REST API v1 and the TypeScript SDK

Everything the web app does with runs can be done over HTTP: start a mission, follow it, decide its plan, read its deliverable, and talk to the assistants it built. The API is versioned under `/api/v1`; its shapes come from one set of schemas that the server, the SDK and the OpenAPI document share ([ADR 0018](../adr/0018-platform-interfaces.md)).

- OpenAPI 3.1: `GET /api/v1/openapi.json` (no token needed)
- TypeScript SDK: `@delegate/sdk`
- CLI: [`delegate`](./cli.md)
- Push instead of polling: [webhooks](./webhooks.md)

## Authentication

Create an API token in the web app under **Settings → Connections**. It is shown once and stored only as a hash. Send it as a bearer token:

```bash
export DELEGATE_URL=https://delegate.example
export DELEGATE_TOKEN=dlg_...

curl -s "$DELEGATE_URL/api/v1/runs" -H "Authorization: Bearer $DELEGATE_TOKEN"
```

A token belongs to one workspace and acts as the user who created it. v1 accepts **only** bearer tokens: browser session cookies are ignored there, so a web page cannot make a visitor's browser call v1 on their behalf.

## Conventions

**Errors** always have the same body, and every response carries `X-Request-Id`:

```json
{
  "error": {
    "code": "invalid_request",
    "message": "The body does not match the v1 contract.",
    "requestId": "req_5f0c1c0e7f5b4f0e9a430f9d2b0f6f11",
    "issues": ["input.url: company-xray needs url"]
  }
}
```

Branch on `code`, never on `message`.

| Code | Status | Meaning |
|---|---|---|
| `invalid_request` | 400 | The path, query or body does not match the contract; `issues` lists why. |
| `invalid_json` | 400 | The body is not valid JSON. |
| `invalid_url` | 400 | The target is not a public company website or GitHub repository. |
| `invalid_idempotency_key` | 400 | `Idempotency-Key` is empty, longer than 255 characters or not printable ASCII. |
| `unauthorized` | 401 | The token is missing, malformed, unknown or revoked. |
| `forbidden` | 403 | The token's user is not allowed to do this. |
| `not_found` | 404 | Nothing with that id is visible to this token's workspace. |
| `run_finished` | 409 | The run already reached a terminal state. |
| `no_pending_plan` | 409 | The run has no plan waiting for a decision. |
| `idempotency_in_progress` | 409 | A request with this `Idempotency-Key` is still being processed; retry shortly. |
| `payload_too_large` | 413 | The body is larger than the operation accepts (8 KB; 64 KB for chat). |
| `unsupported_media_type` | 415 | The body must be `application/json`. |
| `idempotency_key_reused` | 422 | The key was already used with a different request. |
| `rate_limited` | 429 | A request or run quota is used up; `Retry-After` says when to try again. |
| `internal` | 500 | The server failed; quote the `requestId`. |
| `unavailable` | 503 | A dependency (model capacity, the knowledge store) is unavailable right now. |

Another workspace's run is `not_found`, not `forbidden`: the API does not reveal that an id exists.

**Idempotency.** Send an `Idempotency-Key` header (any unique string up to 255 printable ASCII characters, a UUID is fine) on a `POST` to make it safe to retry. The key is scoped to the token's workspace and remembered for 24 hours:

- the same key with the same request returns the first response again, with `Idempotent-Replayed: true`
- the same key with a different method, path or body is `422 idempotency_key_reused`
- a duplicate that arrives while the first is still running is `409 idempotency_in_progress` with `Retry-After`
- only successful responses are remembered: after an error the same key can be retried

**Rate limits.** Each token may make 1,200 requests per hour. Every response reports the budget in `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` (seconds until the window resets); a `429` also has `Retry-After`. Starting runs and asking assistants count against the same per-user and per-network quotas as the web app.

**Pagination.** Lists return `{ "data": [...], "nextCursor": "..." }`. Pass `nextCursor` back as `cursor` until it is `null`. Cursors are opaque.

**Unknown fields** in a request are rejected. Responses may gain fields; ignore the ones you do not know.

## Operations

| Method and path | What it does |
|---|---|
| `POST /api/v1/runs` | Start a run |
| `GET /api/v1/runs` | List runs, newest first (`limit`, `cursor`, `status`) |
| `GET /api/v1/runs/{runId}` | Status, steps, artifacts, pending decisions, the deliverable once completed, child runs of an Autopilot run |
| `POST /api/v1/runs/{runId}/cancel` | Cancel a run that has not finished |
| `GET /api/v1/runs/{runId}/events` | The run's event log: JSON pages, or Server-Sent Events |
| `POST /api/v1/runs/{runId}/plan/approve` | Approve the proposed plan |
| `POST /api/v1/runs/{runId}/plan/reject` | Reject it (`{ "reason": "..." }` is optional) |
| `GET /api/v1/runs/{runId}/artifacts` | List the run's artifacts |
| `GET /api/v1/runs/{runId}/artifacts/{artifactId}` | One artifact with its content |
| `GET /api/v1/assistants` | Assistants this workspace has built |
| `POST /api/v1/assistants/{assistantId}/chat` | Ask an assistant a question |
| `GET /api/v1/openapi.json` | This API as OpenAPI 3.1 |

Approving side effects (a connector tool call, opening a pull request) is deliberately **not** in the API. Those decisions are made by a person in the web app, where the full arguments or the diff are shown. A run that waits for one lists it in `pendingApprovals` and links to the page in `webUrl`.

### Start a run

```bash
curl -s -X POST "$DELEGATE_URL/api/v1/runs" \
  -H "Authorization: Bearer $DELEGATE_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"missionId":"repo-xray","input":{"url":"https://github.com/vercel/next.js"}}'
```

The answer is `201` with the run and a `Location` header.

| `missionId` | Needs | Optional |
|---|---|---|
| `company-xray` | `url` | `focus` |
| `automation-audit` | `url` | `focus`, `department` |
| `build-agent` | `url`, `goal` | `name`, `opportunityId`, and `parentRunId` beside `input` |
| `custom-goal` | `goal` | `url` |
| `repo-xray` | `url` (a public GitHub repository) | `ref` |
| `autopilot` | `goal` | `url` |

A run starts in `planning`. Unless the workspace approves plans automatically, it then waits in `awaiting_plan_approval` with the plan in `pendingPlan`. Statuses: `planning`, `awaiting_plan_approval`, `running`, `awaiting_approval`, `completed`, `failed`. A cancelled run is `failed` with `error.code` `cancelled`. `terminal` is `true` once nothing more will happen.

### Follow a run

Poll `GET /runs/{runId}` until `terminal` is true, or read the event log.

As JSON pages:

```bash
curl -s "$DELEGATE_URL/api/v1/runs/$RUN/events?after=0&limit=200" \
  -H "Authorization: Bearer $DELEGATE_TOKEN"
```

```json
{ "data": [{ "runId": "...", "seq": 1, "at": "...", "type": "run.created", "payload": {} }],
  "nextAfter": 1, "hasMore": false, "terminal": false }
```

Pass `nextAfter` as `after` for the next page. When `terminal` is true and `hasMore` is false, no event will follow.

As a stream, send `Accept: text/event-stream` on the same path:

```bash
curl -N "$DELEGATE_URL/api/v1/runs/$RUN/events" \
  -H "Authorization: Bearer $DELEGATE_TOKEN" -H "Accept: text/event-stream"
```

Stored events after `after` (or after the `Last-Event-ID` header) are replayed, then new ones arrive live. Each run event is one message whose `id` is its sequence, `event` its type and `data` the event as JSON. Control messages are named `stream.replay`, `stream.live`, `stream.end` and `stream.error`. The stream closes after the terminal event, or when the server's time limit is reached (serverless functions run for at most five minutes): reconnect with the last sequence you saw. A finished run with nothing left answers `204`.

Event types include `plan.proposed`, `plan.approved`, `step.started`, `step.completed`, `artifact.created`, `approval.requested`, `run.completed` and `run.failed`; the OpenAPI document has the full list. New types may be added.

### Decide a plan

```bash
curl -s -X POST "$DELEGATE_URL/api/v1/runs/$RUN/plan/approve" \
  -H "Authorization: Bearer $DELEGATE_TOKEN"
```

Editing a plan before approving it is done in the web app.

### Ask an assistant

```bash
curl -s -X POST "$DELEGATE_URL/api/v1/assistants/$ASSISTANT/chat" \
  -H "Authorization: Bearer $DELEGATE_TOKEN" -H "Content-Type: application/json" \
  -d '{"question":"What is the refund policy?"}'
```

The answer has `answer`, `citations`, `grounded`, and `refused` with a `refusal` reason when the assistant declined because its sources do not say. Nothing is stored between calls: send earlier turns in `history`. With `Accept: text/event-stream` the answer is streamed as `delta`, `citation`, `refusal` and `done` messages.

## TypeScript SDK

`@delegate/sdk` is a typed client for every operation. It depends only on `zod`, uses `fetch`, streams and WebCrypto, and runs in Node 20 or later and in modern browsers.

```ts
import { createDelegateClient, DelegateApiError, DelegateTimeoutError } from "@delegate/sdk";

const delegate = createDelegateClient({
  baseUrl: process.env.DELEGATE_URL ?? "http://localhost:3000",
  token: process.env.DELEGATE_TOKEN ?? "",
});

const run = await delegate.runs.create({
  missionId: "repo-xray",
  input: { url: "https://github.com/vercel/next.js" },
});

for await (const event of delegate.runs.events(run.id)) {
  if (event.type === "plan.proposed") await delegate.runs.approvePlan(run.id);
  if (event.type === "step.completed") console.log(event.stepId, event.payload.summary);
}

const finished = await delegate.runs.get(run.id);
console.log(finished.status, finished.deliverable?.title, finished.webUrl);
```

- `runs.create`, `get`, `list`, `iterate` (all pages), `cancel`, `approvePlan`, `rejectPlan`, `listEvents`, `events`, `wait`
- `artifacts.list`, `artifacts.get`
- `assistants.list`, `assistants.chat`, `assistants.chatStream`
- `runs.events(runId, { after, signal })` is an async iterator over the event stream. It reconnects from the last sequence when the server closes the stream and ends after the terminal event.
- `waitForRun(runId, { timeoutMs, until })` polls until the run is terminal, or with `until: "attention"` until it needs a decision. It throws `DelegateTimeoutError` (with `lastRun`) when the time is up; the default is ten minutes.
- Every `POST` gets an `Idempotency-Key` automatically, so the SDK can retry it safely; pass `{ idempotencyKey }` to choose your own. Requests are retried twice on connection errors, `429`, `502`, `503` and `504`, honouring `Retry-After` up to 30 seconds.
- `rateLimit()` returns the budget from the last response.

Errors are typed:

| Class | When | Useful fields |
|---|---|---|
| `DelegateApiError` | The API answered with an error | `status`, `code`, `message`, `requestId`, `issues`, `retryAfterMs` |
| `DelegateConnectionError` | The server could not be reached or timed out | `cause` |
| `DelegateResponseError` | A `2xx` body did not match the contract | `operation`, `issues`, `requestId` |
| `DelegateTimeoutError` | `waitForRun` ran out of time | `runId`, `timeoutMs`, `lastRun` |

```ts
try {
  await delegate.runs.cancel(run.id);
} catch (error) {
  if (error instanceof DelegateApiError && error.code === "run_finished") return;
  throw error;
}
```

The request and response schemas are exported from `@delegate/sdk/contract` if you want to validate on your side, and webhook verification is in `@delegate/sdk/webhooks`.

## What v1 does not cover yet

- Approving side effects (by design, see above) and editing plans
- Managing API tokens, connectors and webhook endpoints: those are in the web app
- Forking a run, playbooks, evals
- The request counter behind the rate-limit headers is kept per server instance, so under load on several instances the effective limit can be higher than the header says
