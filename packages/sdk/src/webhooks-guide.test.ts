import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_HEADERS,
  WEBHOOK_SECRET_PREFIX,
  WEBHOOK_TOLERANCE_SECONDS,
} from "./contract/webhooks";
import { signWebhookPayload, verifyWebhook } from "./webhooks";

const GUIDE = fileURLToPath(new URL("../../../docs/guides/webhooks.md", import.meta.url));
const SAMPLE = /<!-- verify-sample:start -->\s*```js\n([\s\S]*?)```\s*<!-- verify-sample:end -->/;

interface SampleInput {
  rawBody: string | Buffer;
  headers: Record<string, string | undefined>;
  secret: string;
  now?: number;
}

const SampleModule = z.object({
  verifyDelegateWebhook: z.custom<(input: SampleInput) => unknown>(
    (value) => typeof value === "function",
  ),
});

const guide = readFileSync(GUIDE, "utf8");
const secret = `${WEBHOOK_SECRET_PREFIX}${"k".repeat(43)}`;
const signedAt = 1_795_608_000;
const body = JSON.stringify({
  id: "3f0c1c0e-7f5b-4f0e-9a43-0f9d2b0f6f11",
  type: "run.completed",
  created: "2026-11-25T12:03:11.000Z",
  apiVersion: "v1",
  data: {
    run: {
      id: "7d1d4f3e-2b8e-4c41-9e0f-3c2b1a0d9e8f",
      mission: "repo-xray",
      target: "vercel/next.js",
      status: "completed",
      createdAt: "2026-11-25T12:00:02.000Z",
      startedAt: "2026-11-25T12:00:03.000Z",
      finishedAt: "2026-11-25T12:03:11.000Z",
      summary: "Mapped 12 packages, café included.",
      error: null,
      totals: { inputTokens: 48_211, outputTokens: 9_120, costMicroUsd: 0 },
      url: "https://delegate.example/runs/7d1d4f3e-2b8e-4c41-9e0f-3c2b1a0d9e8f",
    },
  },
});

let directory: string;
let verifySample: (input: SampleInput) => unknown;
let headers: Record<string, string>;

beforeAll(async () => {
  const source = SAMPLE.exec(guide)?.[1];
  if (source === undefined) throw new Error("docs/guides/webhooks.md has no verification sample");
  directory = await mkdtemp(path.join(tmpdir(), "delegate-webhook-guide-"));
  const file = path.join(directory, "verify.mjs");
  await writeFile(file, source, "utf8");
  verifySample = SampleModule.parse(await import(pathToFileURL(file).href)).verifyDelegateWebhook;
  headers = {
    [WEBHOOK_HEADERS.timestamp]: String(signedAt),
    [WEBHOOK_HEADERS.signature]: await signWebhookPayload(secret, signedAt, body),
  };
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

const at = (offsetSeconds: number) => (signedAt + offsetSeconds) * 1000;

describe("the verification sample in docs/guides/webhooks.md", () => {
  it("uses only node:crypto", () => {
    const source = SAMPLE.exec(guide)?.[1] ?? "";
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
    expect(imports).toEqual(["node:crypto"]);
  });

  it("accepts a delivery signed by Delegate, as a string or as bytes", () => {
    expect(verifySample({ rawBody: body, headers, secret, now: at(2) })).toEqual(JSON.parse(body));
    expect(
      verifySample({ rawBody: Buffer.from(body, "utf8"), headers, secret, now: at(2) }),
    ).toEqual(JSON.parse(body));
    expect(
      verifySample({ rawBody: body, headers, secret, now: at(WEBHOOK_TOLERANCE_SECONDS) }),
    ).toEqual(JSON.parse(body));
  });

  it("rejects a replay of an old signed delivery", () => {
    for (const offset of [WEBHOOK_TOLERANCE_SECONDS + 1, 3_600, 86_400 * 30])
      expect(() => verifySample({ rawBody: body, headers, secret, now: at(offset) })).toThrow(
        /replay/,
      );
    expect(() =>
      verifySample({ rawBody: body, headers, secret, now: at(-WEBHOOK_TOLERANCE_SECONDS - 1) }),
    ).toThrow(/replay/);
  });

  it("rejects a replay whose timestamp header was moved forward", async () => {
    const later = signedAt + 86_400;
    const moved = { ...headers, [WEBHOOK_HEADERS.timestamp]: String(later) };
    expect(() =>
      verifySample({ rawBody: body, headers: moved, secret, now: later * 1000 }),
    ).toThrow(/signature mismatch/);
    await expect(
      verifyWebhook({ payload: body, headers: moved, secret, now: () => later * 1000 }),
    ).rejects.toMatchObject({ reason: "signature_mismatch" });
  });

  it("rejects a changed body, another secret and missing or malformed headers", () => {
    const now = at(1);
    const tampered = body.replace("completed", "failed   ");
    expect(() => verifySample({ rawBody: tampered, headers, secret, now })).toThrow(/mismatch/);
    expect(() => verifySample({ rawBody: body, headers, secret: `${secret}x`, now })).toThrow(
      /mismatch/,
    );
    expect(() => verifySample({ rawBody: body, headers: {}, secret, now })).toThrow(/missing/);
    for (const signature of ["", "v1=", "v1=abc", "v0=deadbeef", `v1=${"z".repeat(64)}`])
      expect(() =>
        verifySample({
          rawBody: body,
          headers: { ...headers, [WEBHOOK_HEADERS.signature]: signature },
          secret,
          now,
        }),
      ).toThrow(/mismatch/);
    expect(() =>
      verifySample({
        rawBody: body,
        headers: { ...headers, [WEBHOOK_HEADERS.timestamp]: "soon" },
        secret,
        now,
      }),
    ).toThrow(/malformed timestamp/);
  });

  it("accepts one valid signature among several", () => {
    const several = `v1=${"0".repeat(64)}, ${headers[WEBHOOK_HEADERS.signature] ?? ""}`;
    expect(
      verifySample({
        rawBody: body,
        headers: { ...headers, [WEBHOOK_HEADERS.signature]: several },
        secret,
        now: at(1),
      }),
    ).toEqual(JSON.parse(body));
  });

  it("decides like the SDK verifier", async () => {
    const cases: [string, number, string, string][] = [
      ["fresh", 1, body, secret],
      ["replayed", 301, body, secret],
      ["tampered", 1, `${body} `, secret],
      ["other secret", 1, body, `${WEBHOOK_SECRET_PREFIX}${"j".repeat(43)}`],
    ];
    for (const [name, offset, payload, key] of cases) {
      const now = at(offset);
      let sample = true;
      try {
        verifySample({ rawBody: payload, headers, secret: key, now });
      } catch {
        sample = false;
      }
      const sdk = await verifyWebhook({ payload, headers, secret: key, now: () => now }).then(
        () => true,
        () => false,
      );
      expect([name, sample], name).toEqual([name, sdk]);
    }
  });
});

describe("docs/guides/webhooks.md", () => {
  it("names every event type, header and the tolerance the contract defines", () => {
    for (const type of WEBHOOK_EVENT_TYPES) expect(guide).toContain(`\`${type}\``);
    for (const header of Object.values(WEBHOOK_HEADERS))
      expect(guide.toLowerCase()).toContain(header);
    expect(guide).toContain(`const TOLERANCE_SECONDS = ${WEBHOOK_TOLERANCE_SECONDS};`);
    expect(guide).toContain(WEBHOOK_SECRET_PREFIX);
  });
});
