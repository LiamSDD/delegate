import { isIP } from "node:net";

import { type LinkStatus } from "./xray";

export const LINK_CHECK_USER_AGENT = "DelegateEval/0.1 (link check; low volume)";

export interface LinkCheckOptions {
  fetchImpl?: typeof fetch;
  concurrency?: number;
  timeoutMs?: number;
  perHostDelayMs?: number;
  cache?: Map<string, LinkStatus>;
  sleep?: (ms: number) => Promise<void>;
}

const ALIVE_BUT_BLOCKED = new Set([401, 403, 429]);
const RETRY_WITH_GET = new Set([403, 405, 501]);

function checkable(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "unsupported scheme";
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    if (host === "localhost" || host.endsWith(".localhost") || isIP(host) !== 0)
      return "host not allowed";
    return undefined;
  } catch {
    return "invalid URL";
  }
}

export async function checkLinks(
  urls: readonly string[],
  options: LinkCheckOptions = {},
): Promise<Map<string, LinkStatus>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const cache = options.cache ?? new Map<string, LinkStatus>();
  const timeoutMs = options.timeoutMs ?? 10_000;
  const perHostDelayMs = options.perHostDelayMs ?? 1_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const lastByHost = new Map<string, number>();
  const results = new Map<string, LinkStatus>();
  const queue = [...new Set(urls)];

  const request = async (url: string, method: "HEAD" | "GET") => {
    const response = await fetchImpl(url, {
      method,
      redirect: "follow",
      headers: { "user-agent": LINK_CHECK_USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel().catch(() => undefined);
    return response.status;
  };

  const probe = async (url: string): Promise<LinkStatus> => {
    const refused = checkable(url);
    if (refused !== undefined) return { ok: false, error: refused };
    const host = new URL(url).host;
    const wait = (lastByHost.get(host) ?? -Infinity) + perHostDelayMs - Date.now();
    lastByHost.set(host, Date.now() + Math.max(0, wait));
    if (wait > 0) await sleep(wait);
    try {
      let status = await request(url, "HEAD");
      if (RETRY_WITH_GET.has(status)) status = await request(url, "GET");
      return { ok: status < 400 || ALIVE_BUT_BLOCKED.has(status), status };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message.slice(0, 120) : "failed" };
    }
  };

  const worker = async () => {
    for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
      const cached = cache.get(url);
      const status = cached ?? (await probe(url));
      cache.set(url, status);
      results.set(url, status);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 2) }, worker));
  return results;
}
