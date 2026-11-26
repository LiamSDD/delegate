import type { WebhookDeliveryListing } from "@/server/webhooks/endpoints";

export const ENDPOINTS_PATH = "/settings/webhooks/endpoints";

export type DeliveryTone = "ok" | "waiting" | "failed";

export interface DeliveryState {
  tone: DeliveryTone;
  label: string;
  detail: string;
}

const instant = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

export function formatInstant(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : `${instant.format(at)} UTC`;
}

const ERROR_TEXT: Record<string, string> = {
  http_error: "the endpoint answered",
  redirect: "the endpoint answered with a redirect, which is not followed:",
  timeout: "the endpoint did not answer within 10 seconds",
  network: "the endpoint could not be reached",
  blocked: "the URL now points at a private or disallowed address",
  encryption_key_missing: "DELEGATE_ENCRYPTION_KEY is missing, so the delivery cannot be signed",
  secret_unreadable: "the stored secret cannot be decrypted; rotate it",
  invalid_payload: "the stored event could not be rendered",
  abandoned: "the attempts ran out while a delivery was in flight",
};

function reason(delivery: WebhookDeliveryListing): string {
  const text =
    delivery.lastError === null
      ? "no attempt yet"
      : (ERROR_TEXT[delivery.lastError] ?? delivery.lastError);
  const showsCode = delivery.lastError === "http_error" || delivery.lastError === "redirect";
  return delivery.lastStatusCode !== null && showsCode
    ? `${text} HTTP ${delivery.lastStatusCode}`
    : text;
}

export function deliveryState(
  delivery: WebhookDeliveryListing,
  maxAttempts: number,
): DeliveryState {
  if (delivery.status === "delivered")
    return {
      tone: "ok",
      label: "delivered",
      detail: `delivered with HTTP ${delivery.lastStatusCode ?? 200} on attempt ${delivery.attempts}`,
    };
  if (delivery.status === "failed")
    return {
      tone: "failed",
      label: "failed",
      detail: `gave up after ${delivery.attempts} ${delivery.attempts === 1 ? "attempt" : "attempts"}: ${reason(delivery)}`,
    };
  if (delivery.attempts === 0)
    return { tone: "waiting", label: "queued", detail: "queued for its first attempt" };
  return {
    tone: "waiting",
    label: "retrying",
    detail: `attempt ${delivery.attempts} of ${maxAttempts} failed: ${reason(delivery)}; next attempt ${
      delivery.nextAttemptAt === null ? "soon" : `after ${formatInstant(delivery.nextAttemptAt)}`
    }`,
  };
}

export function errorMessage(body: unknown, status: number): string {
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "object" &&
    body.error !== null &&
    "message" in body.error &&
    typeof body.error.message === "string"
  )
    return body.error.message;
  return `Request failed (${status})`;
}
