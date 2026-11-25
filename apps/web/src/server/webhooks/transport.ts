import type { ResolveDns } from "@delegate/runtime/security";
import { createPinnedFetch, redactPii, systemResolveDns } from "@delegate/runtime/server";

import { WEBHOOK_TIMEOUT_MS } from "./policy";
import { assertPublicHost, validateWebhookUrl, WebhookUrlError } from "./url";

export const WEBHOOK_EXCERPT_MAX_CHARS = 200;
const EXCERPT_READ_BYTES = 2_048;
const RETRY_AFTER_CEILING_SECONDS = 86_400;

export interface WebhookRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export type WebhookSendOutcome =
  | { kind: "response"; status: number; excerpt: string; retryAfterMs: number | null }
  | { kind: "blocked"; problem: string }
  | { kind: "timeout" }
  | { kind: "network" };

export type WebhookTransport = (request: WebhookRequest) => Promise<WebhookSendOutcome>;

export function redactExcerpt(text: string): string {
  const flattened = text
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const withoutTokens = redactPii(flattened).text.replace(
    /[A-Za-z0-9+/_=-]{24,}/g,
    "[redacted:token]",
  );
  return withoutTokens.length <= WEBHOOK_EXCERPT_MAX_CHARS
    ? withoutTokens
    : `${withoutTokens.slice(0, WEBHOOK_EXCERPT_MAX_CHARS - 1)}…`;
}

async function readExcerpt(response: Response): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < EXCERPT_READ_BYTES) {
      const chunk = await reader.read();
      if (chunk.done) break;
      chunks.push(chunk.value.subarray(0, EXCERPT_READ_BYTES - total));
      total += chunk.value.byteLength;
    }
  } catch {
    return "";
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return redactExcerpt(new TextDecoder().decode(bytes));
}

function retryAfterMs(value: string | null, now: number): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d{1,9}$/.test(trimmed))
    return Math.min(Number(trimmed), RETRY_AFTER_CEILING_SECONDS) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.min(Math.max(0, at - now), RETRY_AFTER_CEILING_SECONDS * 1000);
}

function errorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const code = (current as Error & { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = current.cause;
  }
  return undefined;
}

export interface WebhookTransportOptions {
  resolveDns?: ResolveDns;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

export function createWebhookTransport(options: WebhookTransportOptions = {}): WebhookTransport {
  const resolveDns = options.resolveDns ?? systemResolveDns;
  const send = options.fetchImpl ?? createPinnedFetch(resolveDns);
  const timeoutMs = options.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  return async (request) => {
    let url: URL;
    try {
      url = validateWebhookUrl(request.url);
      await assertPublicHost(url, resolveDns);
    } catch (error) {
      if (error instanceof WebhookUrlError) return { kind: "blocked", problem: error.problem };
      throw error;
    }
    const deadline = { passed: false };
    const controller = new AbortController();
    const timer = setTimeout(() => {
      deadline.passed = true;
      controller.abort();
    }, timeoutMs);
    try {
      const response = await send(url.href, {
        method: "POST",
        headers: request.headers,
        body: request.body,
        redirect: "manual",
        signal: controller.signal,
      });
      return {
        kind: "response",
        status: response.status,
        excerpt: await readExcerpt(response),
        retryAfterMs: retryAfterMs(response.headers.get("retry-after"), now()),
      };
    } catch (error) {
      if (deadline.passed) return { kind: "timeout" };
      if (errorCode(error) === "EBLOCKED") return { kind: "blocked", problem: "private_address" };
      return { kind: "network" };
    } finally {
      clearTimeout(timer);
    }
  };
}
