"use client";

import { useState, type ReactNode, type SyntheticEvent } from "react";

import type { WebhookDeliveryListing, WebhookEndpointListing } from "@/server/webhooks/endpoints";
import type { WebhooksOverview } from "@/server/webhooks/settings-api";

import {
  deliveryState,
  ENDPOINTS_PATH,
  errorMessage,
  formatInstant,
  type DeliveryTone,
} from "./format";

const inputClass =
  "h-9 w-full rounded-md border border-border bg-surface px-3 text-sm text-text placeholder:text-text-subtle focus-visible:border-border-strong focus-visible:outline-none";
const primaryButton =
  "inline-flex h-9 items-center justify-center rounded-md bg-text px-4 text-sm font-medium text-surface hover:opacity-90 disabled:opacity-50";
const quietButton =
  "inline-flex h-8 items-center justify-center rounded-md border border-border px-3 text-sm text-text-muted hover:border-border-strong hover:text-text disabled:opacity-50";
const dangerButton =
  "inline-flex h-8 items-center justify-center rounded-md border border-danger/40 px-3 text-sm text-danger hover:border-danger disabled:opacity-50";

const TONE_CLASS: Record<DeliveryTone, string> = {
  ok: "border-success/40 bg-success-soft text-success",
  waiting: "border-warning/40 bg-warning-soft text-warning",
  failed: "border-danger/40 bg-danger-soft text-danger",
};

async function send(path: string, method: string, body?: unknown): Promise<unknown> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(errorMessage(json, response.status));
  return json;
}

function Section({
  id,
  title,
  lede,
  children,
}: {
  id: string;
  title: string;
  lede: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-5 border-t border-border pt-8">
      <div className="flex max-w-2xl flex-col gap-2">
        <h2 id={id} className="text-lg font-medium text-text">
          {title}
        </h2>
        <p className="text-sm text-text-muted text-pretty">{lede}</p>
      </div>
      {children}
    </section>
  );
}

function ErrorLine({ message }: { message: string | null }) {
  return message === null ? null : (
    <p role="alert" className="text-sm text-danger">
      {message}
    </p>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={quietButton}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => {
            setCopied(false);
          }, 1500);
        });
      }}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

interface FreshSecret {
  endpointId: string;
  host: string;
  secret: string;
  rotated: boolean;
}

function SecretCallout({ fresh, onDismiss }: { fresh: FreshSecret; onDismiss: () => void }) {
  return (
    <div
      role="status"
      className="flex flex-col gap-2 rounded-lg border border-accent/40 bg-accent-soft p-4"
    >
      <p className="text-sm text-text">
        {fresh.rotated
          ? `New signing secret for ${fresh.host}. The previous secret stopped working just now.`
          : `Signing secret for ${fresh.host}.`}{" "}
        Copy it now: Delegate stores it encrypted and cannot show it again.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <code className="min-w-0 flex-1 overflow-x-auto font-mono text-xs break-all text-text">
          {fresh.secret}
        </code>
        <CopyButton text={fresh.secret} label="Copy secret" />
        <button type="button" className={quietButton} onClick={onDismiss}>
          Done
        </button>
      </div>
    </div>
  );
}

function EndpointRow({
  endpoint,
  busy,
  confirming,
  onTest,
  onRotate,
  onDelete,
  onConfirm,
}: {
  endpoint: WebhookEndpointListing;
  busy: boolean;
  confirming: "rotate" | "delete" | null;
  onTest: () => void;
  onRotate: () => void;
  onDelete: () => void;
  onConfirm: (action: "rotate" | "delete" | null) => void;
}) {
  return (
    <li className="flex flex-col gap-3 border-b border-border px-4 py-4 last:border-b-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="font-mono text-sm break-all text-text">{endpoint.url}</p>
          {endpoint.description === "" ? null : (
            <p className="text-sm text-text-muted">{endpoint.description}</p>
          )}
          <p className="font-mono text-2xs text-text-subtle">
            added {formatInstant(endpoint.createdAt)}
            {endpoint.secretRotatedAt === null
              ? ""
              : ` · secret rotated ${formatInstant(endpoint.secretRotatedAt)}`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={quietButton} disabled={busy} onClick={onTest}>
            Send test
          </button>
          <button
            type="button"
            className={quietButton}
            disabled={busy}
            onClick={() => {
              onConfirm("rotate");
            }}
          >
            Rotate secret
          </button>
          <button
            type="button"
            className={quietButton}
            disabled={busy}
            onClick={() => {
              onConfirm("delete");
            }}
          >
            Delete
          </button>
        </div>
      </div>
      <ul className="flex flex-wrap gap-1.5" aria-label="Subscribed events">
        {endpoint.events.map((type) => (
          <li
            key={type}
            className="rounded-md bg-surface-2 px-2 py-0.5 font-mono text-2xs text-text-muted"
          >
            {type}
          </li>
        ))}
      </ul>
      {confirming === null ? null : (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface-2 px-3 py-2">
          <p className="min-w-0 flex-1 basis-full text-sm text-text sm:basis-0">
            {confirming === "rotate"
              ? "Rotating replaces the secret at once: deliveries signed with the old one stop verifying until your receiver has the new secret."
              : "Deleting stops deliveries to this URL and removes its delivery log."}
          </p>
          <button
            type="button"
            className={confirming === "delete" ? dangerButton : quietButton}
            disabled={busy}
            onClick={confirming === "rotate" ? onRotate : onDelete}
          >
            {confirming === "rotate" ? "Rotate now" : "Delete endpoint"}
          </button>
          <button
            type="button"
            className={quietButton}
            onClick={() => {
              onConfirm(null);
            }}
          >
            Cancel
          </button>
        </div>
      )}
    </li>
  );
}

function DeliveryRow({
  delivery,
  host,
  maxAttempts,
}: {
  delivery: WebhookDeliveryListing;
  host: string;
  maxAttempts: number;
}) {
  const state = deliveryState(delivery, maxAttempts);
  return (
    <li className="grid gap-x-4 gap-y-1 border-b border-border px-4 py-3 last:border-b-0 md:grid-cols-[9rem_1fr_auto] md:items-baseline">
      <p className="font-mono text-2xs text-text-subtle">{formatInstant(delivery.createdAt)}</p>
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-sm text-text">
          <span className="font-mono">{delivery.eventType}</span>{" "}
          <span className="text-text-muted">to {host}</span>
        </p>
        <p className="font-mono text-2xs text-text-subtle">{state.detail}</p>
        {delivery.lastResponseExcerpt === null || delivery.lastResponseExcerpt === "" ? null : (
          <p className="truncate font-mono text-2xs text-text-subtle">
            response: {delivery.lastResponseExcerpt}
          </p>
        )}
        {delivery.runId === null ? null : (
          <a
            href={`/runs/${delivery.runId}`}
            className="w-fit font-mono text-2xs text-text-muted underline underline-offset-4 hover:text-text"
          >
            run {delivery.runId.slice(0, 8)}
          </a>
        )}
      </div>
      <span
        className={`w-fit rounded-md border px-2 py-0.5 font-mono text-2xs ${TONE_CLASS[state.tone]}`}
      >
        {state.label}
      </span>
    </li>
  );
}

export function WebhooksPanel({ initial }: { initial: WebhooksOverview }) {
  const [overview, setOverview] = useState(initial);
  const [fresh, setFresh] = useState<FreshSecret | null>(null);
  const [error, setError] = useState<{ section: string; message: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{
    id: string;
    action: "rotate" | "delete";
  } | null>(null);
  const [form, setForm] = useState({
    url: "",
    description: "",
    events: initial.eventTypes.map((entry) => entry.type as string),
  });

  const run = async (section: string, action: () => Promise<void>) => {
    setBusy(section);
    setError(null);
    setNotice(null);
    try {
      await action();
      setOverview((await send(ENDPOINTS_PATH, "GET")) as WebhooksOverview);
    } catch (failure) {
      setError({ section, message: failure instanceof Error ? failure.message : "Failed" });
    } finally {
      setBusy(null);
    }
  };
  const errorFor = (section: string) => (error?.section === section ? error.message : null);
  const hostOf = (endpointId: string) =>
    overview.endpoints.find((endpoint) => endpoint.id === endpointId)?.host ?? "a deleted endpoint";
  const atLimit = overview.endpoints.length >= overview.maxEndpoints;

  const addEndpoint = (event: SyntheticEvent) => {
    event.preventDefault();
    void run("endpoints", async () => {
      const created = (await send(ENDPOINTS_PATH, "POST", {
        url: form.url,
        events: form.events,
        description: form.description,
      })) as { endpoint: WebhookEndpointListing; secret: string };
      setFresh({
        endpointId: created.endpoint.id,
        host: created.endpoint.host,
        secret: created.secret,
        rotated: false,
      });
      setForm({ ...form, url: "", description: "" });
    });
  };

  return (
    <div className="flex flex-col gap-12">
      <Section
        id="webhook-endpoints"
        title="Endpoints"
        lede={`Delegate sends a signed JSON POST to each endpoint when a run finishes, fails or is cancelled, or when it waits for a decision. Up to ${overview.maxEndpoints} endpoints per workspace; https only, public hosts only, redirects are not followed.`}
      >
        {overview.encryptionConfigured ? null : (
          <p className="rounded-lg border border-warning/40 bg-warning-soft px-4 py-3 text-sm text-warning">
            DELEGATE_ENCRYPTION_KEY is not set on this deployment, so endpoints cannot be added: the
            signing secret has to be stored encrypted. Generate a key with{" "}
            <code className="font-mono text-xs">openssl rand -hex 32</code>.
          </p>
        )}
        <form onSubmit={addEndpoint} className="grid max-w-3xl gap-4 md:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-sm text-text-muted">
            Endpoint URL
            <input
              className={inputClass}
              required
              type="url"
              maxLength={2048}
              pattern="https://.+"
              title="An https:// URL"
              placeholder="https://example.com/hooks/delegate"
              value={form.url}
              onChange={(event) => {
                setForm({ ...form, url: event.target.value });
              }}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm text-text-muted">
            Description (optional)
            <input
              className={inputClass}
              maxLength={120}
              placeholder="e.g. Slack notifier"
              value={form.description}
              onChange={(event) => {
                setForm({ ...form, description: event.target.value });
              }}
            />
          </label>
          <fieldset className="flex flex-col gap-2 md:col-span-2">
            <legend className="mb-2 text-sm text-text-muted">Events</legend>
            {overview.eventTypes.map((entry) => (
              <label key={entry.type} className="flex items-start gap-3 text-sm text-text">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={form.events.includes(entry.type)}
                  onChange={(event) => {
                    setForm({
                      ...form,
                      events: event.target.checked
                        ? [...form.events, entry.type]
                        : form.events.filter((type) => type !== entry.type),
                    });
                  }}
                />
                <span className="flex flex-col gap-0.5">
                  <span className="font-mono text-xs">{entry.type}</span>
                  <span className="text-xs text-text-muted">{entry.meaning}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="flex flex-wrap items-center gap-3 md:col-span-2">
            <button
              type="submit"
              className={primaryButton}
              disabled={
                busy !== null ||
                atLimit ||
                !overview.encryptionConfigured ||
                form.events.length === 0
              }
            >
              {busy === "endpoints" ? "Checking the URL…" : "Add endpoint"}
            </button>
            {atLimit ? (
              <p className="text-sm text-text-muted">
                This workspace has the maximum of {overview.maxEndpoints} endpoints.
              </p>
            ) : null}
            {form.events.length === 0 ? (
              <p className="text-sm text-text-muted">Choose at least one event.</p>
            ) : null}
          </div>
        </form>
        <ErrorLine message={errorFor("endpoints")} />
        {fresh === null ? null : (
          <SecretCallout
            fresh={fresh}
            onDismiss={() => {
              setFresh(null);
            }}
          />
        )}
        {notice === null ? null : (
          <p role="status" className="text-sm text-text-muted">
            {notice}
          </p>
        )}
        {overview.endpoints.length === 0 ? (
          <p className="text-sm text-text-subtle">No endpoints yet.</p>
        ) : (
          <ul className="flex flex-col rounded-xl border border-border bg-surface shadow-sm">
            {overview.endpoints.map((endpoint) => (
              <EndpointRow
                key={endpoint.id}
                endpoint={endpoint}
                busy={busy !== null}
                confirming={confirming?.id === endpoint.id ? confirming.action : null}
                onConfirm={(action) => {
                  setConfirming(action === null ? null : { id: endpoint.id, action });
                }}
                onTest={() => {
                  void run("endpoints", async () => {
                    const result = (await send(
                      `${ENDPOINTS_PATH}/${endpoint.id}/test`,
                      "POST",
                    )) as {
                      delivery: WebhookDeliveryListing;
                    };
                    const state = deliveryState(result.delivery, 1);
                    setNotice(`Test delivery to ${endpoint.host}: ${state.detail}.`);
                  });
                }}
                onRotate={() => {
                  setConfirming(null);
                  void run("endpoints", async () => {
                    const rotated = (await send(
                      `${ENDPOINTS_PATH}/${endpoint.id}/rotate`,
                      "POST",
                    )) as { endpoint: WebhookEndpointListing; secret: string };
                    setFresh({
                      endpointId: endpoint.id,
                      host: rotated.endpoint.host,
                      secret: rotated.secret,
                      rotated: true,
                    });
                  });
                }}
                onDelete={() => {
                  setConfirming(null);
                  void run("endpoints", async () => {
                    await send(`${ENDPOINTS_PATH}/${endpoint.id}`, "DELETE");
                    if (fresh?.endpointId === endpoint.id) setFresh(null);
                  });
                }}
              />
            ))}
          </ul>
        )}
      </Section>

      <Section
        id="webhook-deliveries"
        title="Recent deliveries"
        lede={`The last 50 deliveries with their outcome. A failed attempt is retried after 1 minute, 5 minutes, 30 minutes, 2 hours and 8 hours, ${overview.maxAttempts} attempts in all. There is no background queue: a retry that is due is sent on this workspace's next API request or visit to this page. Only a short, redacted excerpt of each response is kept.`}
      >
        <div>
          <button
            type="button"
            className={quietButton}
            disabled={busy !== null}
            onClick={() => {
              void run("deliveries", () => Promise.resolve());
            }}
          >
            {busy === "deliveries" ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        <ErrorLine message={errorFor("deliveries")} />
        {overview.deliveries.length === 0 ? (
          <p className="text-sm text-text-subtle">
            Nothing delivered yet. Add an endpoint and send a test.
          </p>
        ) : (
          <ul className="flex flex-col rounded-xl border border-border bg-surface shadow-sm">
            {overview.deliveries.map((delivery) => (
              <DeliveryRow
                key={delivery.id}
                delivery={delivery}
                host={hostOf(delivery.endpointId)}
                maxAttempts={overview.maxAttempts}
              />
            ))}
          </ul>
        )}
      </Section>

      <Section
        id="webhook-verification"
        title="Verify every delivery"
        lede="Each request carries Delegate-Timestamp (Unix seconds) and Delegate-Signature: v1= followed by the hex HMAC-SHA256 of the timestamp, a dot and the raw body, keyed with the endpoint's secret. Reject a delivery whose signature does not match or whose timestamp is more than five minutes from now: that is what stops a replay."
      >
        <pre className="max-w-3xl overflow-x-auto rounded-md bg-surface-2 p-3 font-mono text-xs leading-relaxed text-text">
          {`import { verifyWebhook } from "@delegate/sdk/webhooks";

const event = await verifyWebhook({
  payload: rawBody,            // the bytes as received, before JSON.parse
  headers: request.headers,
  secret: process.env.DELEGATE_WEBHOOK_SECRET,
});`}
        </pre>
        <p className="max-w-2xl text-sm text-text-muted">
          A dependency-free version for any runtime is in{" "}
          <code className="font-mono text-xs">docs/guides/webhooks.md</code>. Deliveries can arrive
          more than once; deduplicate on the event <code className="font-mono text-xs">id</code>.
        </p>
      </Section>
    </div>
  );
}
