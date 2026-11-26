import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { classifyAddress } from "@delegate/runtime/security";
import { ConnectorUrlError, refuseRedirects, validateConnectorUrl } from "@delegate/runtime/server";
import {
  signWebhookPayload,
  verifyWebhook,
  WEBHOOK_HEADERS,
  WEBHOOK_SECRET_PREFIX,
  WebhookVerificationError,
} from "@delegate/sdk";
import { z } from "zod";

import { fakeNetwork, type FakeNetwork } from "./network";
import { type WebhookDeliveryPayloadSchema, type WebhookSignaturePayloadSchema } from "./schema";

interface Verdict {
  blockedBy: string;
  evidence: string[];
}

export const WEBHOOK_GUIDE_PATH = fileURLToPath(
  new URL("../../../../docs/guides/webhooks.md", import.meta.url),
);
const SAMPLE = /<!-- verify-sample:start -->\s*```js\n([\s\S]*?)```\s*<!-- verify-sample:end -->/;

function joined(labels: readonly string[]): string {
  return labels.length === 0 ? "none" : [...new Set(labels)].sort().join("+");
}

async function resolvesPublicly(network: FakeNetwork, host: string): Promise<boolean> {
  const addresses = await network.resolveDns(host);
  return addresses.length > 0 && addresses.every((address) => classifyAddress(address).allowed);
}

async function guarded(network: FakeNetwork, raw: string, labels: string[]): Promise<URL | null> {
  let url: URL;
  try {
    url = validateConnectorUrl(raw, { production: true });
  } catch (error) {
    if (!(error instanceof ConnectorUrlError)) throw error;
    labels.push(`webhook:url:${error.problem}`);
    return null;
  }
  if (await resolvesPublicly(network, url.hostname)) return url;
  labels.push("webhook:dns-private");
  return null;
}

async function deliver(network: FakeNetwork, raw: string, labels: string[]): Promise<void> {
  const url = await guarded(network, raw, labels);
  if (url === null) return;
  try {
    await refuseRedirects(network.fetchImpl)(url.href, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  } catch (error) {
    if (!(error instanceof ConnectorUrlError)) throw error;
    labels.push("webhook:no-redirect");
  }
}

export async function runWebhookDelivery(
  payload: z.infer<typeof WebhookDeliveryPayloadSchema>,
): Promise<Verdict> {
  const labels: string[] = [];
  const atRegistration = fakeNetwork(payload.network);
  await guarded(atRegistration, payload.url, labels);
  const atDelivery = fakeNetwork({
    ...payload.network,
    dns: { ...payload.network?.dns, ...payload.dnsAtDelivery },
  });
  await deliver(atDelivery, payload.url, labels);
  const reached = new Set([
    ...atRegistration.contacted(payload.forbiddenHosts),
    ...atDelivery.contacted(payload.forbiddenHosts),
  ]);
  return {
    blockedBy: joined(labels),
    evidence: [...reached].map((host) => `a webhook request reached ${host}`),
  };
}

interface SampleInput {
  rawBody: string;
  headers: Record<string, string>;
  secret: string;
  now: number;
}

const SampleModule = z.object({
  verifyDelegateWebhook: z.custom<(input: SampleInput) => unknown>(
    (value) => typeof value === "function",
  ),
});

let sample: Promise<(input: SampleInput) => unknown> | undefined;

function guideSample(): Promise<(input: SampleInput) => unknown> {
  sample ??= (async () => {
    const source = SAMPLE.exec(readFileSync(WEBHOOK_GUIDE_PATH, "utf8"))?.[1];
    if (source === undefined)
      throw new Error("docs/guides/webhooks.md has no verification sample to attack");
    const directory = await mkdtemp(path.join(tmpdir(), "delegate-redteam-webhook-"));
    try {
      const file = path.join(directory, "verify.mjs");
      await writeFile(file, source, "utf8");
      return SampleModule.parse(await import(pathToFileURL(file).href)).verifyDelegateWebhook;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  })();
  return sample;
}

const SIGNED_AT = 1_795_608_000;
const SECRET = `${WEBHOOK_SECRET_PREFIX}${"a".repeat(43)}`;
const OTHER_SECRET = `${WEBHOOK_SECRET_PREFIX}${"b".repeat(43)}`;

function delivery(type: string, status: string): string {
  return JSON.stringify({
    id: "3f0c1c0e-7f5b-4f0e-9a43-0f9d2b0f6f11",
    type,
    created: new Date(SIGNED_AT * 1000).toISOString(),
    apiVersion: "v1",
    data: {
      run: {
        id: "7d1d4f3e-2b8e-4c41-9e0f-3c2b1a0d9e8f",
        mission: "repo-xray",
        target: "acme/site",
        status,
        createdAt: new Date((SIGNED_AT - 180) * 1000).toISOString(),
        startedAt: new Date((SIGNED_AT - 179) * 1000).toISOString(),
        finishedAt: new Date(SIGNED_AT * 1000).toISOString(),
        summary: status === "completed" ? "Done." : null,
        error:
          status === "completed" ? null : { code: "budget_exceeded", message: "Out of budget." },
        totals: { inputTokens: 1, outputTokens: 1, costMicroUsd: 0 },
        url: "https://delegate.example/runs/7d1d4f3e-2b8e-4c41-9e0f-3c2b1a0d9e8f",
      },
    },
  });
}

export async function runWebhookSignature(
  payload: z.infer<typeof WebhookSignaturePayloadSchema>,
): Promise<Verdict> {
  const genuine = delivery("run.failed", "failed");
  const signature = await signWebhookPayload(SECRET, SIGNED_AT, genuine);
  const fresh = await verifyWebhook({
    payload: genuine,
    headers: {
      [WEBHOOK_HEADERS.timestamp]: String(SIGNED_AT),
      [WEBHOOK_HEADERS.signature]: signature,
    },
    secret: SECRET,
    now: () => SIGNED_AT * 1000,
  }).then(
    () => true,
    () => false,
  );
  if (!fresh) throw new Error("the genuine delivery does not verify, so the attack proves nothing");

  let body = genuine;
  let timestamp = String(SIGNED_AT);
  let presented = signature;
  let receivedAt = SIGNED_AT + 5;
  switch (payload.attack) {
    case "replay":
      receivedAt = SIGNED_AT + payload.ageSeconds;
      break;
    case "moved-timestamp":
      receivedAt = SIGNED_AT + payload.ageSeconds;
      timestamp = String(receivedAt);
      break;
    case "tampered-body":
      body = delivery("run.completed", "completed");
      break;
    case "other-secret":
      presented = await signWebhookPayload(OTHER_SECRET, SIGNED_AT, genuine);
      break;
    case "unsigned":
      presented = payload.signature;
      break;
  }
  const headers = {
    [WEBHOOK_HEADERS.timestamp]: timestamp,
    [WEBHOOK_HEADERS.signature]: presented,
  };
  const now = receivedAt * 1000;
  const evidence: string[] = [];
  let label = "none";
  try {
    await verifyWebhook({ payload: body, headers, secret: SECRET, now: () => now });
    evidence.push("the SDK verifier accepted the delivery");
  } catch (error) {
    if (!(error instanceof WebhookVerificationError)) throw error;
    label = `webhook-verify:${error.reason}`;
  }
  const verifySample = await guideSample();
  try {
    verifySample({ rawBody: body, headers, secret: SECRET, now });
    evidence.push("the verification sample in docs/guides/webhooks.md accepted the delivery");
  } catch {
    if (evidence.length === 0 && label === "none") label = "webhook-verify:sample-only";
  }
  return { blockedBy: label, evidence };
}
