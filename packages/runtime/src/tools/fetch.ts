import { isBlockedEgressHost } from "@delegate/policy";

import { classifyAddress, isIpLiteral } from "./ip";
import { parseRobots, type Robots } from "./robots";

export const USER_AGENT = "DelegateBot/0.1 (+https://github.com/LiamSDD/delegate)";
export const FETCH_DEFAULTS = {
  timeoutMs: 15_000,
  maxBytes: 2 * 1024 * 1024,
  maxRedirects: 5,
  maxPages: 25,
  perHostIntervalMs: 1_000,
} as const;

export type FetchBlockCode =
  | "invalid_url"
  | "scheme"
  | "credentials"
  | "port"
  | "ip_literal"
  | "blocked_host"
  | "dns_failed"
  | "blocked_address"
  | "robots"
  | "too_many_redirects"
  | "content_type"
  | "too_large"
  | "timeout"
  | "page_cap"
  | "http_error"
  | "network"
  | "aborted";

export class FetchBlockedError extends Error {
  override readonly name = "FetchBlockedError";
  constructor(
    readonly code: FetchBlockCode,
    readonly url: string,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export interface HostOutcome {
  latencyMs: number;
  status?: number;
  retryAfterMs?: number;
  failed?: boolean;
}

export type HostRelease = (outcome: HostOutcome) => void;

export interface HostGate {
  acquire(host: string, signal?: AbortSignal): Promise<HostRelease>;
  setCrawlDelay(host: string, delayMs: number): void;
}

export type ResolveDns = (host: string) => Promise<string[]>;

export interface FetcherOptions {
  fetchImpl: typeof fetch;
  resolveDns: ResolveDns;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  userAgent?: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  maxPages?: number;
  perHostIntervalMs?: number;
  allowPublicIpLiterals?: boolean;
  hostGate?: HostGate;
}

export interface FetchRequest {
  url: string;
  signal?: AbortSignal;
  respectRobots?: boolean;
  accept?: string;
}

export interface FetchedDocument {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  text: string;
  bytes: number;
  truncated?: true;
  fetchedAt: string;
}

export interface Fetcher {
  fetch(request: FetchRequest): Promise<FetchedDocument>;
  pagesFetched(): number;
  sitemapsFor(url: string): Promise<string[]>;
  gate?: HostGate;
}

const ALLOWED_PORTS = new Set(["", "80", "443"]);
const ALLOWED_CONTENT_TYPES = [
  /^text\/html$/,
  /^application\/xhtml\+xml$/,
  /^text\/plain$/,
  /^text\/xml$/,
  /^application\/xml$/,
  /^application\/[a-z0-9.+-]*\+xml$/,
  /^application\/json$/,
  /^application\/[a-z0-9.+-]*\+json$/,
];
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,application/json;q=0.8";

const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Math.min(Number(trimmed) * 1000, MAX_RETRY_AFTER_MS);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.min(Math.max(0, at - nowMs), MAX_RETRY_AFTER_MS);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function validateFetchUrl(raw: string, allowPublicIpLiterals = false): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchBlockedError("invalid_url", raw, "Not a valid absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FetchBlockedError("scheme", raw, `Scheme ${url.protocol} is not allowed`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new FetchBlockedError("credentials", raw, "Credentials in URLs are not allowed");
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    throw new FetchBlockedError("port", raw, `Port ${url.port} is not allowed`);
  }
  const host = url.hostname;
  if (isIpLiteral(host)) {
    if (!allowPublicIpLiterals) {
      throw new FetchBlockedError("ip_literal", raw, "IP-literal hosts are not allowed");
    }
    const verdict = classifyAddress(host.replace(/^\[|\]$/g, ""));
    if (!verdict.allowed) {
      throw new FetchBlockedError("blocked_address", raw, `Address is in a ${verdict.range} range`);
    }
    return url;
  }
  if (isBlockedEgressHost(host)) {
    throw new FetchBlockedError("blocked_host", raw, `Host ${host} is local, internal or private`);
  }
  return url;
}

function mediaType(header: string | null): string {
  return (header ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

function charsetOf(header: string | null): string {
  const match = /charset\s*=\s*"?([^";\s]+)/i.exec(header ?? "");
  return match?.[1]?.toLowerCase() ?? "utf-8";
}

function decode(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

class Deadline {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  timedOut = false;

  constructor(timeoutMs: number, outer: AbortSignal | undefined) {
    this.timer = setTimeout(() => {
      this.timedOut = true;
      this.controller.abort();
    }, timeoutMs);
    this.signal =
      outer === undefined
        ? this.controller.signal
        : AbortSignal.any([this.controller.signal, outer]);
  }

  clear(): void {
    clearTimeout(this.timer);
  }

  whenAborted(): Promise<never> {
    return new Promise((_resolve, reject) => {
      const fire = () => {
        reject(new Error("aborted"));
      };
      if (this.signal.aborted) fire();
      else this.signal.addEventListener("abort", fire, { once: true });
    });
  }
}

async function readCapped(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  deadline: Deadline,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  const aborted = deadline.whenAborted();
  aborted.catch(() => undefined);
  try {
    for (;;) {
      const result = await Promise.race([reader.read(), aborted]);
      if (result.done) break;
      const room = maxBytes - total;
      if (result.value.byteLength > room) {
        chunks.push(result.value.subarray(0, room));
        total += room;
        truncated = true;
        break;
      }
      total += result.value.byteLength;
      chunks.push(result.value);
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
}

export function createFetcher(options: FetcherOptions): Fetcher {
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? defaultSleep;
  const userAgent = options.userAgent ?? USER_AGENT;
  const timeoutMs = options.timeoutMs ?? FETCH_DEFAULTS.timeoutMs;
  const maxBytes = options.maxBytes ?? FETCH_DEFAULTS.maxBytes;
  const maxRedirects = options.maxRedirects ?? FETCH_DEFAULTS.maxRedirects;
  const maxPages = options.maxPages ?? FETCH_DEFAULTS.maxPages;
  const interval = options.perHostIntervalMs ?? FETCH_DEFAULTS.perHostIntervalMs;
  const allowLiterals = options.allowPublicIpLiterals === true;
  const nextSlot = new Map<string, number>();
  const robotsCache = new Map<string, Promise<Robots | "unreachable">>();
  let pages = 0;

  async function assertPublic(url: URL): Promise<void> {
    if (isIpLiteral(url.hostname)) return;
    let addresses: string[];
    try {
      addresses = await options.resolveDns(url.hostname);
    } catch {
      throw new FetchBlockedError("dns_failed", url.href, `Could not resolve ${url.hostname}`);
    }
    if (addresses.length === 0) {
      throw new FetchBlockedError("dns_failed", url.href, `${url.hostname} has no addresses`);
    }
    for (const address of addresses) {
      const verdict = classifyAddress(address);
      if (!verdict.allowed) {
        throw new FetchBlockedError(
          "blocked_address",
          url.href,
          `${url.hostname} resolves into a ${verdict.range} range`,
        );
      }
    }
  }

  async function politeSlot(host: string): Promise<void> {
    const current = now().getTime();
    const slot = Math.max(current, nextSlot.get(host) ?? 0);
    nextSlot.set(host, slot + interval);
    const wait = slot - current;
    if (wait > 0) await sleep(wait);
  }

  async function robotsFor(
    url: URL,
    signal: AbortSignal | undefined,
  ): Promise<Robots | "unreachable"> {
    const cached = robotsCache.get(url.origin);
    if (cached !== undefined) return cached;
    const loading = (async () => {
      try {
        const document = await request(
          {
            url: `${url.origin}/robots.txt`,
            respectRobots: false,
            accept: "text/plain",
            ...(signal === undefined ? {} : { signal }),
          },
          false,
          true,
        );
        const robots = parseRobots(document.text);
        const delay = robots.crawlDelaySeconds(userAgent);
        if (delay !== undefined && delay > 0)
          options.hostGate?.setCrawlDelay(url.host, delay * 1000);
        return robots;
      } catch (error) {
        if (error instanceof FetchBlockedError) {
          const clientError =
            error.code === "http_error" && error.status !== undefined && error.status < 500;
          if (clientError || error.code === "content_type") return parseRobots("");
        }
        return "unreachable" as const;
      }
    })();
    robotsCache.set(url.origin, loading);
    return loading;
  }

  async function assertRobots(url: URL, signal: AbortSignal | undefined): Promise<void> {
    const robots = await robotsFor(url, signal);
    if (robots === "unreachable") {
      throw new FetchBlockedError(
        "robots",
        url.href,
        "robots.txt is unreachable; treated as disallow",
      );
    }
    if (!robots.isAllowed(`${url.pathname}${url.search}`, userAgent)) {
      throw new FetchBlockedError("robots", url.href, "Disallowed by robots.txt");
    }
  }

  async function request(
    input: FetchRequest,
    countsAsPage: boolean,
    anyContentType = false,
  ): Promise<FetchedDocument> {
    if (input.signal?.aborted === true) {
      throw new FetchBlockedError("aborted", input.url, "The run was cancelled");
    }
    if (countsAsPage) {
      if (pages >= maxPages) {
        throw new FetchBlockedError("page_cap", input.url, `Page cap of ${maxPages} reached`);
      }
      pages += 1;
    }
    const deadline = new Deadline(timeoutMs, input.signal);
    const fail = (url: string, error: unknown): never => {
      if (error instanceof FetchBlockedError) throw error;
      if (deadline.timedOut) {
        throw new FetchBlockedError("timeout", url, `No complete response within ${timeoutMs} ms`);
      }
      if (input.signal?.aborted === true) {
        throw new FetchBlockedError("aborted", url, "The run was cancelled");
      }
      throw new FetchBlockedError(
        "network",
        url,
        error instanceof Error ? error.message : "Request failed",
      );
    };
    let current = input.url;
    try {
      for (let hop = 0; ; hop += 1) {
        const url = validateFetchUrl(current, allowLiterals);
        await assertPublic(url);
        if (input.respectRobots !== false) await assertRobots(url, input.signal);
        let release: HostRelease | undefined;
        if (options.hostGate === undefined) await politeSlot(url.host);
        else release = await options.hostGate.acquire(url.host, deadline.signal);
        const startedAt = now().getTime();
        const settle = (outcome: Omit<HostOutcome, "latencyMs">) => {
          release?.({ latencyMs: Math.max(0, now().getTime() - startedAt), ...outcome });
          release = undefined;
        };
        let response: Response;
        try {
          response = await options.fetchImpl(url.href, {
            method: "GET",
            redirect: "manual",
            headers: { "user-agent": userAgent, accept: input.accept ?? DEFAULT_ACCEPT },
            signal: deadline.signal,
          });
        } catch (error) {
          settle({ failed: true });
          return fail(url.href, error);
        }
        try {
          if (REDIRECT_STATUSES.has(response.status)) {
            settle({ status: response.status });
            await response.body?.cancel().catch(() => undefined);
            const location = response.headers.get("location");
            if (location === null) {
              throw new FetchBlockedError(
                "http_error",
                url.href,
                "Redirect without a location",
                response.status,
              );
            }
            if (hop >= maxRedirects) {
              throw new FetchBlockedError(
                "too_many_redirects",
                input.url,
                `More than ${maxRedirects} redirects`,
              );
            }
            current = new URL(location, url).href;
            continue;
          }
          if (!response.ok) {
            const retryAfterMs = parseRetryAfter(
              response.headers.get("retry-after"),
              now().getTime(),
            );
            settle({
              status: response.status,
              failed: response.status >= 500 || response.status === 429,
              ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
            });
            await response.body?.cancel().catch(() => undefined);
            throw new FetchBlockedError(
              "http_error",
              url.href,
              `HTTP ${response.status}`,
              response.status,
              retryAfterMs,
            );
          }
          const header = response.headers.get("content-type");
          const type = mediaType(header);
          if (!anyContentType && !ALLOWED_CONTENT_TYPES.some((pattern) => pattern.test(type))) {
            await response.body?.cancel().catch(() => undefined);
            throw new FetchBlockedError(
              "content_type",
              url.href,
              `Content type ${type || "missing"} is not allowed`,
            );
          }
          const { bytes, truncated } =
            response.body === null
              ? { bytes: new Uint8Array(), truncated: false }
              : await readCapped(response.body, maxBytes, deadline).catch((error: unknown) =>
                  fail(url.href, error),
                );
          settle({ status: response.status });
          return {
            url: input.url,
            finalUrl: url.href,
            status: response.status,
            contentType: type,
            text: decode(bytes, charsetOf(header)),
            bytes: bytes.byteLength,
            ...(truncated ? { truncated: true } : {}),
            fetchedAt: now().toISOString(),
          };
        } finally {
          settle({ failed: true });
        }
      }
    } catch (error) {
      return fail(current, error);
    } finally {
      deadline.clear();
    }
  }

  return {
    fetch: (input) => request(input, true),
    pagesFetched: () => pages,
    sitemapsFor: async (url) => {
      const robots = await robotsFor(validateFetchUrl(url, allowLiterals), undefined);
      return robots === "unreachable" ? [] : robots.sitemaps;
    },
    ...(options.hostGate === undefined ? {} : { gate: options.hostGate }),
  };
}
