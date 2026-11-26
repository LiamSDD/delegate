import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { WEBHOOK_HEADERS, WEBHOOK_SECRET_PREFIX } from "./contract/webhooks";
import {
  WebhookVerificationError,
  isKnownWebhookEvent,
  signWebhookPayload,
  verifyWebhook,
} from "./webhooks";

const endpointKey = (fill: string) => `${WEBHOOK_SECRET_PREFIX}${fill.repeat(43)}`;
const KEY = endpointKey("k");
const OTHER_KEY = endpointKey("o");
const NOW_SECONDS = 1_795_600_000;
const now = () => NOW_SECONDS * 1000;

const EVENT = {
  id: "0d5f3a52-58c1-4a09-9a53-6b1f6c0c8d11",
  type: "run.completed",
  created: "2026-11-25T10:00:00.000Z",
  apiVersion: "v1",
  data: {
    run: {
      id: "7d1d4f3e-2b8e-4c41-9e0f-3c2b1a0d9e8f",
      mission: "repo-xray",
      target: "pallets/click",
      status: "completed",
      createdAt: "2026-11-25T09:58:00.000Z",
      startedAt: "2026-11-25T09:58:01.000Z",
      finishedAt: "2026-11-25T10:00:00.000Z",
      summary: "Architecture map and five ranked improvements.",
      error: null,
      totals: { inputTokens: 1200, outputTokens: 800, costMicroUsd: 0 },
      url: "https://delegate.example/runs/7d1d4f3e-2b8e-4c41-9e0f-3c2b1a0d9e8f",
    },
  },
};
const BODY = JSON.stringify(EVENT);

async function signed(
  body = BODY,
  timestamp = NOW_SECONDS,
  key = KEY,
): Promise<Record<string, string>> {
  return {
    [WEBHOOK_HEADERS.timestamp]: String(timestamp),
    [WEBHOOK_HEADERS.signature]: await signWebhookPayload(key, timestamp, body),
  };
}

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  const failure = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(WebhookVerificationError);
  return (failure as WebhookVerificationError).reason;
}

describe("signWebhookPayload", () => {
  it("is HMAC-SHA256 over timestamp.body, hex, with a v1= prefix", async () => {
    const expected = createHmac("sha256", KEY).update(`${NOW_SECONDS}.${BODY}`).digest("hex");
    expect(await signWebhookPayload(KEY, NOW_SECONDS, BODY)).toBe(`v1=${expected}`);
  });

  it("refuses a timestamp that is not whole seconds", async () => {
    await expect(signWebhookPayload(KEY, 1.5, BODY)).rejects.toThrow(TypeError);
    await expect(signWebhookPayload(KEY, -1, BODY)).rejects.toThrow(TypeError);
  });
});

describe("verifyWebhook", () => {
  it("returns the typed event for a fresh, correctly signed delivery", async () => {
    const event = await verifyWebhook({ payload: BODY, headers: await signed(), secret: KEY, now });
    expect(isKnownWebhookEvent(event)).toBe(true);
    expect(event).toEqual(EVENT);
  });

  it("accepts Headers objects, mixed-case names and raw bytes", async () => {
    const headers = await signed();
    const viaHeaders = new Headers(headers);
    const mixedCase = {
      "Delegate-Timestamp": headers[WEBHOOK_HEADERS.timestamp],
      "Delegate-Signature": headers[WEBHOOK_HEADERS.signature],
    };
    const bytes = new TextEncoder().encode(BODY);
    for (const candidate of [viaHeaders, mixedCase])
      await expect(
        verifyWebhook({ payload: bytes, headers: candidate, secret: KEY, now }),
      ).resolves.toMatchObject({ id: EVENT.id });
    await expect(
      verifyWebhook({ payload: bytes.buffer, headers, secret: KEY, now }),
    ).resolves.toMatchObject({ id: EVENT.id });
  });

  it("rejects a replay: a delivery signed more than five minutes ago", async () => {
    const headers = await signed(BODY, NOW_SECONDS - 301);
    expect(await reasonOf(verifyWebhook({ payload: BODY, headers, secret: KEY, now }))).toBe(
      "timestamp_out_of_tolerance",
    );
    await expect(
      verifyWebhook({
        payload: BODY,
        headers: await signed(BODY, NOW_SECONDS - 300),
        secret: KEY,
        now,
      }),
    ).resolves.toBeDefined();
  });

  it("rejects a delivery dated in the future beyond the tolerance", async () => {
    const headers = await signed(BODY, NOW_SECONDS + 301);
    expect(await reasonOf(verifyWebhook({ payload: BODY, headers, secret: KEY, now }))).toBe(
      "timestamp_out_of_tolerance",
    );
  });

  it("rejects an old delivery replayed under a fresh timestamp", async () => {
    const old = await signed(BODY, NOW_SECONDS - 3_600);
    const forged = { ...old, [WEBHOOK_HEADERS.timestamp]: String(NOW_SECONDS) };
    expect(
      await reasonOf(verifyWebhook({ payload: BODY, headers: forged, secret: KEY, now })),
    ).toBe("signature_mismatch");
  });

  it("rejects a body changed after signing, even by one byte", async () => {
    const headers = await signed();
    const tampered = BODY.replace("pallets/click", "pallets/clicK");
    expect(await reasonOf(verifyWebhook({ payload: tampered, headers, secret: KEY, now }))).toBe(
      "signature_mismatch",
    );
    expect(await reasonOf(verifyWebhook({ payload: `${BODY} `, headers, secret: KEY, now }))).toBe(
      "signature_mismatch",
    );
  });

  it("rejects a signature made with another endpoint's key", async () => {
    const headers = await signed(BODY, NOW_SECONDS, OTHER_KEY);
    expect(await reasonOf(verifyWebhook({ payload: BODY, headers, secret: KEY, now }))).toBe(
      "signature_mismatch",
    );
  });

  it("accepts any matching v1 value and any of several keys, for rotation", async () => {
    const good = await signed();
    const decoy = `v1=${"0".repeat(64)}`;
    await expect(
      verifyWebhook({
        payload: BODY,
        headers: {
          ...good,
          [WEBHOOK_HEADERS.signature]: `${decoy}, ${good[WEBHOOK_HEADERS.signature] ?? ""}`,
        },
        secret: KEY,
        now,
      }),
    ).resolves.toBeDefined();
    await expect(
      verifyWebhook({ payload: BODY, headers: good, secret: [OTHER_KEY, KEY], now }),
    ).resolves.toBeDefined();
    expect(
      await reasonOf(
        verifyWebhook({
          payload: BODY,
          headers: good,
          secret: [OTHER_KEY, endpointKey("x")],
          now,
        }),
      ),
    ).toBe("signature_mismatch");
  });

  it("rejects missing headers and malformed timestamps", async () => {
    const headers = await signed();
    expect(
      await reasonOf(
        verifyWebhook({
          payload: BODY,
          headers: { [WEBHOOK_HEADERS.signature]: headers[WEBHOOK_HEADERS.signature] },
          secret: KEY,
          now,
        }),
      ),
    ).toBe("missing_headers");
    for (const timestamp of ["", " 1795600000", "1795600000.0", "1.7956e9", "-1", "0x6b0a", "now"])
      expect(
        await reasonOf(
          verifyWebhook({
            payload: BODY,
            headers: { ...headers, [WEBHOOK_HEADERS.timestamp]: timestamp },
            secret: KEY,
            now,
          }),
        ),
        JSON.stringify(timestamp),
      ).toBe("malformed_timestamp");
  });

  it("rejects signature headers without a well-formed v1 value", async () => {
    const headers = await signed();
    const hex = (headers[WEBHOOK_HEADERS.signature] ?? "").slice(3);
    for (const value of [
      "",
      hex,
      `v0=${hex}`,
      `sha256=${hex}`,
      `v1=${hex.slice(0, 32)}`,
      `v1=${hex.toUpperCase()}`,
      `v1=${hex}00`,
      "v1=",
    ])
      expect(
        await reasonOf(
          verifyWebhook({
            payload: BODY,
            headers: { ...headers, [WEBHOOK_HEADERS.signature]: value },
            secret: KEY,
            now,
          }),
        ),
        value.slice(0, 12),
      ).toBe("malformed_signature");
  });

  it("rejects a correctly signed body that is not a Delegate event", async () => {
    for (const body of ["not json", "[]", JSON.stringify({ ...EVENT, data: {} })])
      expect(
        await reasonOf(
          verifyWebhook({ payload: body, headers: await signed(body), secret: KEY, now }),
        ),
        body.slice(0, 12),
      ).toBe("malformed_body");
  });

  it("passes event types it does not know through, flagged as unknown", async () => {
    const body = JSON.stringify({ ...EVENT, type: "run.paused", data: { anything: true } });
    const event = await verifyWebhook({
      payload: body,
      headers: await signed(body),
      secret: KEY,
      now,
    });
    expect(isKnownWebhookEvent(event)).toBe(false);
    expect(event.type).toBe("run.paused");
  });

  it("honours a custom tolerance", async () => {
    const headers = await signed(BODY, NOW_SECONDS - 20);
    expect(
      await reasonOf(
        verifyWebhook({ payload: BODY, headers, secret: KEY, now, toleranceSeconds: 10 }),
      ),
    ).toBe("timestamp_out_of_tolerance");
  });
});
