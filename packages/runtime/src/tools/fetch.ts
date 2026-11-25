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
  ) {
    super(message);
  }
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

export interface DownloadRequest {
  url: string;
  accept: string;
  contentTypes: readonly RegExp[];
  maxBytes: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  respectRobots?: boolean;
}

export interface DownloadedFile {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  bytes: Uint8Array;
  fetchedAt: string;
}

export interface Fetcher {
  fetch(request: FetchRequest): Promise<FetchedDocument>;
  download(request: DownloadRequest): Promise<DownloadedFile>;
  pagesFetched(): number;
  sitemapsFor(url: string): Promise<string[]>;
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
          { countsAsPage: false, contentTypes: "any" },
        );
        return parseRobots(document.text);
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

  interface TransferOptions {
    countsAsPage: boolean;
    contentTypes: readonly RegExp[] | "any";
    maxBytes?: number;
    timeoutMs?: number;
  }

  interface Transfer {
    url: string;
    finalUrl: string;
    status: number;
    contentType: string;
    header: string | null;
    bytes: Uint8Array;
    truncated: boolean;
    fetchedAt: string;
  }

  async function request(input: FetchRequest, mode: TransferOptions): Promise<FetchedDocument> {
    const transfer = await transferBytes(input, mode);
    return {
      url: transfer.url,
      finalUrl: transfer.finalUrl,
      status: transfer.status,
      contentType: transfer.contentType,
      text: decode(transfer.bytes, charsetOf(transfer.header)),
      bytes: transfer.bytes.byteLength,
      ...(transfer.truncated ? { truncated: true } : {}),
      fetchedAt: transfer.fetchedAt,
    };
  }

  async function transferBytes(input: FetchRequest, mode: TransferOptions): Promise<Transfer> {
    const countsAsPage = mode.countsAsPage;
    const limit = mode.maxBytes ?? maxBytes;
    const timeLimit = mode.timeoutMs ?? timeoutMs;
    if (input.signal?.aborted === true) {
      throw new FetchBlockedError("aborted", input.url, "The run was cancelled");
    }
    if (countsAsPage) {
      if (pages >= maxPages) {
        throw new FetchBlockedError("page_cap", input.url, `Page cap of ${maxPages} reached`);
      }
      pages += 1;
    }
    const deadline = new Deadline(timeLimit, input.signal);
    const fail = (url: string, error: unknown): never => {
      if (error instanceof FetchBlockedError) throw error;
      if (deadline.timedOut) {
        throw new FetchBlockedError("timeout", url, `No complete response within ${timeLimit} ms`);
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
        await politeSlot(url.host);
        let response: Response;
        try {
          response = await options.fetchImpl(url.href, {
            method: "GET",
            redirect: "manual",
            headers: { "user-agent": userAgent, accept: input.accept ?? DEFAULT_ACCEPT },
            signal: deadline.signal,
          });
        } catch (error) {
          return fail(url.href, error);
        }
        if (REDIRECT_STATUSES.has(response.status)) {
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
          await response.body?.cancel().catch(() => undefined);
          throw new FetchBlockedError(
            "http_error",
            url.href,
            `HTTP ${response.status}`,
            response.status,
          );
        }
        const header = response.headers.get("content-type");
        const type = mediaType(header);
        const allowed = mode.contentTypes;
        if (allowed !== "any" && !allowed.some((pattern) => pattern.test(type))) {
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
            : await readCapped(response.body, limit, deadline).catch((error: unknown) =>
                fail(url.href, error),
              );
        return {
          url: input.url,
          finalUrl: url.href,
          status: response.status,
          contentType: type,
          header,
          bytes,
          truncated,
          fetchedAt: now().toISOString(),
        };
      }
    } catch (error) {
      return fail(current, error);
    } finally {
      deadline.clear();
    }
  }

  return {
    fetch: (input) => request(input, { countsAsPage: true, contentTypes: ALLOWED_CONTENT_TYPES }),
    download: async (input) => {
      const transfer = await transferBytes(
        {
          url: input.url,
          accept: input.accept,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          ...(input.respectRobots === undefined ? {} : { respectRobots: input.respectRobots }),
        },
        {
          countsAsPage: true,
          contentTypes: input.contentTypes,
          maxBytes: input.maxBytes + 1,
          ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        },
      );
      if (transfer.truncated || transfer.bytes.byteLength > input.maxBytes)
        throw new FetchBlockedError(
          "too_large",
          input.url,
          `Response exceeds the ${input.maxBytes}-byte cap`,
        );
      return {
        url: transfer.url,
        finalUrl: transfer.finalUrl,
        status: transfer.status,
        contentType: transfer.contentType,
        bytes: transfer.bytes,
        fetchedAt: transfer.fetchedAt,
      };
    },
    pagesFetched: () => pages,
    sitemapsFor: async (url) => {
      const robots = await robotsFor(validateFetchUrl(url, allowLiterals), undefined);
      return robots === "unreachable" ? [] : robots.sitemaps;
    },
  };
}
