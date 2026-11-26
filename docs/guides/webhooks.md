# Webhooks

Delegate can tell your systems when a run finishes or needs a decision, so you do not have to poll. You register an HTTPS endpoint, Delegate sends it a signed JSON `POST` for the events you chose, and your endpoint verifies the signature before it trusts the body.

Design and trade-offs: [ADR 0018](../adr/0018-platform-interfaces.md).

## Register an endpoint

Open **Settings → Webhooks** (`/settings/webhooks`) in the web app, enter the URL and choose the events. Only workspace owners and admins can do this, and only from the web app: API tokens cannot manage endpoints.

The signing secret (`dlgwh_…`) is shown **once**, when the endpoint is created or its secret is rotated. Delegate stores it encrypted (AES-256-GCM under `DELEGATE_ENCRYPTION_KEY`) and cannot show it again. A deployment without `DELEGATE_ENCRYPTION_KEY` refuses to create endpoints.

Rules for the URL, checked when you register it and again before every delivery:

- `https://` on the default port, no user name or password in the URL
- a host name, not an IP address
- the host must resolve to public addresses only: private, loopback, link-local and cloud-metadata addresses are refused, and the address is checked again at connect time, so a DNS change after registration does not help an attacker
- redirects are never followed: a `3xx` answer is recorded as a failed attempt

A workspace can have up to 5 endpoints.

## Events

| Type | Sent when |
|---|---|
| `run.completed` | A run finished and its deliverable is ready. |
| `run.failed` | A run stopped with an error. |
| `run.cancelled` | A run was cancelled by a user or through the API. |
| `approval.requested` | A run is waiting for a human: a plan, a connector tool call or a pull request. Not sent when the decision was automatic. |

"Send test" on the settings page sends a `webhook.test` event, signed like any other.

## The request

```http
POST /your/path HTTP/1.1
Content-Type: application/json
User-Agent: Delegate-Webhooks/1.0 (+https://github.com/LiamSDD/delegate)
Delegate-Event: run.completed
Delegate-Delivery: 3f0c1c0e-7f5b-4f0e-9a43-0f9d2b0f6f11
Delegate-Timestamp: 1795608000
Delegate-Signature: v1=5d41402abc4b2a76b9719d911017c592ae2f5d1f0f3a8c1e4b7a9d2c6e8f0a1b
```

```json
{
  "id": "3f0c1c0e-7f5b-4f0e-9a43-0f9d2b0f6f11",
  "type": "run.completed",
  "created": "2026-11-25T12:03:11.000Z",
  "apiVersion": "v1",
  "data": {
    "run": {
      "id": "7d1d4f3e-2b8e-4c41-9e0f-3c2b1a0d9e8f",
      "mission": "repo-xray",
      "target": "vercel/next.js",
      "status": "completed",
      "createdAt": "2026-11-25T12:00:02.000Z",
      "startedAt": "2026-11-25T12:00:03.000Z",
      "finishedAt": "2026-11-25T12:03:11.000Z",
      "summary": "Mapped 12 packages and three risk hotspots.",
      "error": null,
      "totals": { "inputTokens": 48211, "outputTokens": 9120, "costMicroUsd": 0 },
      "url": "https://delegate.example/runs/7d1d4f3e-2b8e-4c41-9e0f-3c2b1a0d9e8f"
    }
  }
}
```

- `id` is the same on every retry of a delivery and equals the `Delegate-Delivery` header. Use it to deduplicate.
- `data.run` is a summary, not the deliverable. Fetch the deliverable with `GET /api/v1/runs/{id}` ([API guide](./api.md)).
- `run.failed` and `run.cancelled` carry `data.run.error` (`{ "code", "message" }`); a cancelled run has the code `cancelled`.
- `approval.requested` adds `data.approval`: `{ "id", "kind", "summary", "url" }`. `kind` is `plan`, `tool` or `ship`. A plan can be decided through the API (`POST /api/v1/runs/{id}/plan/approve`); tool calls and pull requests are decided by a person at `url`.
- New fields and new event types may be added. Ignore what you do not know.

## Verify the signature

The signature is the hex HMAC-SHA256 of `timestamp + "." + body`, keyed with the endpoint's secret:

```text
Delegate-Signature: v1=<hex( HMAC-SHA256( secret, Delegate-Timestamp + "." + raw body ) )>
```

Verify every delivery, in this order:

1. Read the **raw** body bytes. Do not parse and re-serialise the JSON first: the signature covers the bytes as sent.
2. Reject the request if `Delegate-Timestamp` is more than **five minutes** from your clock. Without this check, anyone who once captured a valid delivery could send it again later.
3. Compute the HMAC and compare it with each `v1=` value in the header using a constant-time comparison. The header may carry several comma-separated values.
4. Only then parse the body. Deduplicate on `id`.

### Node.js, no dependencies

<!-- verify-sample:start -->
```js
import { createHmac, timingSafeEqual } from "node:crypto";

const TOLERANCE_SECONDS = 300;

export function verifyDelegateWebhook({ rawBody, headers, secret, now = Date.now() }) {
  const timestamp = headers["delegate-timestamp"];
  const signature = headers["delegate-signature"];
  if (typeof timestamp !== "string" || typeof signature !== "string")
    throw new Error("missing signature headers");
  if (!/^[0-9]{1,12}$/.test(timestamp)) throw new Error("malformed timestamp");
  if (Math.abs(Math.floor(now / 1000) - Number(timestamp)) > TOLERANCE_SECONDS)
    throw new Error("timestamp outside the tolerance: possible replay");
  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest();
  const matches = signature
    .split(",")
    .map((part) => part.trim())
    .filter((part) => /^v1=[0-9a-f]{64}$/.test(part))
    .map((part) => Buffer.from(part.slice(3), "hex"))
    .some((candidate) => timingSafeEqual(candidate, expected));
  if (!matches) throw new Error("signature mismatch");
  return JSON.parse(Buffer.from(rawBody).toString("utf8"));
}
```
<!-- verify-sample:end -->

`rawBody` is a `Buffer` or a string holding exactly the bytes received; `headers` is an object with lower-case names, as Node's `http` module and Express provide. With Express, keep the raw body for this route:

```js
import express from "express";

const app = express();
const seen = new Set(); // use a store with expiry in production

app.post("/hooks/delegate", express.raw({ type: "application/json" }), (req, res) => {
  let event;
  try {
    event = verifyDelegateWebhook({
      rawBody: req.body,
      headers: req.headers,
      secret: process.env.DELEGATE_WEBHOOK_SECRET,
    });
  } catch {
    return res.status(400).end();
  }
  if (seen.has(event.id)) return res.status(204).end();
  seen.add(event.id);
  res.status(204).end(); // answer first, then do the work
  handle(event);
});
```

This sample is executed by the test suite (`packages/sdk/src/webhooks-guide.test.ts`) against deliveries signed by the server's own signer, including a replayed one, so it cannot drift from what Delegate sends.

### With the SDK

`@delegate/sdk/webhooks` does the same with WebCrypto, so it also runs in edge runtimes and browsers, and returns a typed event:

```ts
import { verifyWebhook, WebhookVerificationError } from "@delegate/sdk/webhooks";

export async function POST(request: Request): Promise<Response> {
  try {
    const event = await verifyWebhook({
      payload: await request.arrayBuffer(),
      headers: request.headers,
      secret: process.env.DELEGATE_WEBHOOK_SECRET ?? "",
    });
    if (event.type === "run.completed") console.log(event.data.run.url);
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof WebhookVerificationError) return new Response(null, { status: 400 });
    throw error;
  }
}
```

`error.reason` is one of `missing_headers`, `malformed_timestamp`, `timestamp_out_of_tolerance`, `malformed_signature`, `signature_mismatch`, `malformed_body`. `secret` accepts an array, which is how you accept an old and a new secret while you roll one out on your side.

## Answering, retries and the delivery log

- Answer with any `2xx` within **10 seconds**. Do the real work after you have answered.
- Anything else (another status, a redirect, a timeout, a connection error) is a failed attempt. Delegate retries after **1 minute, 5 minutes, 30 minutes, 2 hours and 8 hours**: six attempts in all, then the delivery is marked failed. A `Retry-After` header on your answer can lengthen a wait, up to a day.
- Delivery is **at least once**. A retry carries the same `id` and body with a new timestamp and signature.
- Delegate runs on serverless functions without a queue. The first attempt is made right after the event happens. A retry that has become due is sent on the workspace's next API request or visit to the Webhooks page, so on a workspace that has gone quiet a retry can be later than the schedule above. The delivery log shows when the next attempt is due.
- **Settings → Webhooks** lists the last 50 deliveries: status, attempts, last response code and the next attempt time. Of your endpoint's response Delegate keeps at most 200 characters, with e-mail addresses, long tokens and other personal data redacted; the response body is not stored.

## Rotating a secret

"Rotate secret" replaces the secret at once and shows the new one once. Deliveries signed after that moment verify only with the new secret, so deploy it to your receiver promptly; attempts that fail in between are retried on the schedule above. If your receiver accepts a list of secrets, add the new one before you rotate and remove the old one afterwards.

## What webhooks do not do

- They do not carry deliverables, plans or tool arguments, only the run summary and, for approvals, a one-line summary and a link.
- They cannot approve anything. Side effects are approved by a person in the web app.
- There is no automatic disabling of an endpoint that keeps failing; delete it on the settings page.
