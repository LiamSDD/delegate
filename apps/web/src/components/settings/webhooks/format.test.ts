import { describe, expect, it } from "vitest";

import type { WebhookDeliveryListing } from "@/server/webhooks/endpoints";
import { DELIVERY_ERRORS } from "@/server/webhooks/dispatch";

import { deliveryState, errorMessage, formatInstant } from "./format";

function delivery(overrides: Partial<WebhookDeliveryListing>): WebhookDeliveryListing {
  return {
    id: "0d2f3c1e-3c5e-4d3c-9d55-6f1c3a529b10",
    endpointId: "6f1c3a52-3c5e-4d3c-9d55-0d2f3c1e9b10",
    runId: null,
    eventType: "run.completed",
    status: "pending",
    attempts: 0,
    lastStatusCode: null,
    lastError: null,
    lastResponseExcerpt: null,
    lastAttemptAt: null,
    nextAttemptAt: "2026-11-25T12:01:00.000Z",
    deliveredAt: null,
    createdAt: "2026-11-25T12:00:00.000Z",
    ...overrides,
  };
}

describe("webhook delivery wording", () => {
  it("describes a delivered, a queued, a retrying and a failed delivery", () => {
    expect(
      deliveryState(delivery({ status: "delivered", attempts: 2, lastStatusCode: 204 }), 6),
    ).toEqual({
      tone: "ok",
      label: "delivered",
      detail: "delivered with HTTP 204 on attempt 2",
    });
    expect(deliveryState(delivery({}), 6)).toMatchObject({ tone: "waiting", label: "queued" });
    expect(
      deliveryState(delivery({ attempts: 1, lastStatusCode: 503, lastError: "http_error" }), 6),
    ).toEqual({
      tone: "waiting",
      label: "retrying",
      detail:
        "attempt 1 of 6 failed: the endpoint answered HTTP 503; next attempt after 25 Nov, 12:01 UTC",
    });
    expect(
      deliveryState(
        delivery({ status: "failed", attempts: 6, lastError: "timeout", nextAttemptAt: null }),
        6,
      ),
    ).toEqual({
      tone: "failed",
      label: "failed",
      detail: "gave up after 6 attempts: the endpoint did not answer within 10 seconds",
    });
    expect(
      deliveryState(
        delivery({ status: "failed", attempts: 1, lastError: "redirect", lastStatusCode: 302 }),
        1,
      ).detail,
    ).toBe(
      "gave up after 1 attempt: the endpoint answered with a redirect, which is not followed: HTTP 302",
    );
  });

  it("has wording for every delivery error the dispatcher records", () => {
    for (const error of DELIVERY_ERRORS) {
      const { detail } = deliveryState(
        delivery({ status: "failed", attempts: 1, lastError: error }),
        6,
      );
      expect(detail.split(": ")[1] ?? "", error).toContain(" ");
    }
  });

  it("formats instants in UTC and falls back to the raw text", () => {
    expect(formatInstant("2026-11-25T09:05:00.000Z")).toBe("25 Nov, 09:05 UTC");
    expect(formatInstant("soon")).toBe("soon");
  });

  it("reads the error envelope and falls back to the status", () => {
    expect(errorMessage({ error: { code: "invalid_url", message: "Not allowed." } }, 400)).toBe(
      "Not allowed.",
    );
    expect(errorMessage(null, 502)).toBe("Request failed (502)");
    expect(errorMessage({ error: "nope" }, 500)).toBe("Request failed (500)");
  });
});
