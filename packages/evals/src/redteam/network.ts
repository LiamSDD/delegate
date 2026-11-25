import { Readable, Transform } from "node:stream";
import { createGunzip, gzipSync } from "node:zlib";

import { FetchBlockedError, createFetcher, type Fetcher } from "@delegate/runtime/security";

import { type CrawlGenerator, type Network, type Route } from "./schema";

export const PUBLIC_ADDRESS = "93.184.215.14";

const ROBOTS: Route = {
  status: 200,
  headers: { "content-type": "text/plain" },
  body: "User-agent: *\nAllow: /\n",
};
const NOT_FOUND: Route = { status: 404, headers: { "content-type": "text/plain" }, body: "" };
const NULL_BODY = new Set([204, 301, 302, 303, 304, 307, 308]);

export function normaliseHost(host: string): string {
  const bare = host.trim().toLowerCase().replace(/\.+$/, "");
  try {
    return new URL(`http://${bare}/`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return bare.replace(/^\[|\]$/g, "");
  }
}

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return input;
  return new URL(input.url);
}

export interface FakeNetwork {
  requests: URL[];
  fetchImpl: typeof fetch;
  resolveDns: (host: string) => Promise<string[]>;
  contacted: (hosts: readonly string[]) => string[];
}

export function fakeNetwork(network: Network | undefined, pages: Record<string, Route> = {}) {
  const requests: URL[] = [];
  const dns = new Map(
    Object.entries(network?.dns ?? {}).map(([host, addresses]) => [normaliseHost(host), addresses]),
  );
  const routes = new Map(
    Object.entries({ ...pages, ...(network?.routes ?? {}) }).map(([url, route]) => [
      new URL(url).href,
      route,
    ]),
  );
  const fetchImpl: typeof fetch = (input) => {
    const url = requestUrl(input);
    requests.push(url);
    const route = routes.get(url.href) ?? (url.pathname === "/robots.txt" ? ROBOTS : NOT_FOUND);
    return Promise.resolve(
      new Response(NULL_BODY.has(route.status) ? null : (route.body ?? ""), {
        status: route.status,
        headers: route.headers ?? {},
      }),
    );
  };
  const fake: FakeNetwork = {
    requests,
    fetchImpl,
    resolveDns: (host) => Promise.resolve(dns.get(normaliseHost(host)) ?? [PUBLIC_ADDRESS]),
    contacted: (hosts) => {
      const forbidden = new Set(hosts.map(normaliseHost));
      return [
        ...new Set(
          requests.map((url) => normaliseHost(url.hostname)).filter((h) => forbidden.has(h)),
        ),
      ];
    },
  };
  return fake;
}

export const SECURITY_FETCH_CODES = new Set([
  "invalid_url",
  "scheme",
  "credentials",
  "port",
  "ip_literal",
  "blocked_host",
  "dns_failed",
  "blocked_address",
  "too_many_redirects",
]);

export interface RecordingFetcher extends Fetcher {
  blocks: string[];
}

export function recordingFetcher(
  network: FakeNetwork,
  options: { allowPublicIpLiterals?: boolean } = {},
): RecordingFetcher {
  const inner = createFetcher({
    fetchImpl: network.fetchImpl,
    resolveDns: network.resolveDns,
    perHostIntervalMs: 0,
    timeoutMs: 5_000,
    sleep: () => Promise.resolve(),
    now: () => new Date("2026-11-25T10:00:00Z"),
    ...(options.allowPublicIpLiterals === undefined
      ? {}
      : { allowPublicIpLiterals: options.allowPublicIpLiterals }),
  });
  const blocks: string[] = [];
  return {
    blocks,
    fetch: async (request) => {
      try {
        return await inner.fetch(request);
      } catch (error) {
        if (error instanceof FetchBlockedError && SECURITY_FETCH_CODES.has(error.code))
          blocks.push(error.code);
        throw error;
      }
    },
    pagesFetched: () => inner.pagesFetched(),
    sitemapsFor: (url) => inner.sitemapsFor(url),
  };
}

function html(body: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><title>Page</title></head><body><main>${body}</main></body></html>`,
    {
      headers: { "content-type": "text/html; charset=utf-8" },
    },
  );
}

function filler(seed: number): string {
  let state = seed + 11;
  return Array.from({ length: 50 }, () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return `term${state % 800}`;
  }).join(" ");
}

function generated(
  generator: CrawlGenerator,
  url: URL,
  counter: { decoded: number },
): Response | undefined {
  switch (generator.kind) {
    case "calendar": {
      if (!url.href.startsWith(generator.prefix)) return undefined;
      const month = Number(url.searchParams.get("month") ?? "0");
      return html(
        `<p>Events in month ${month}. ${filler(month)}</p><a href="${generator.prefix}calendar?month=${month + 1}">Next month</a> <a href="${generator.prefix}calendar?month=${month - 1}">Previous month</a>`,
      );
    }
    case "pagination": {
      if (!url.href.startsWith(generator.prefix)) return undefined;
      const page = Number(url.searchParams.get("page") ?? "1");
      return html(
        `<p>Archive page ${page}. ${filler(1_000 + page)}</p><a href="${generator.prefix}?page=${page + 1}">Older posts</a>`,
      );
    }
    case "repeating-path": {
      if (!url.href.startsWith(generator.prefix)) return undefined;
      const depth = url.pathname.split("/").length;
      return html(
        `<p>Section at depth ${depth}. ${filler(2_000 + depth)}</p><a href="loop/">More</a>`,
      );
    }
    case "link-flood": {
      if (url.href !== generator.url) return undefined;
      const links = Array.from(
        { length: generator.links },
        (_, index) => `<a href="/flood/${index}">${index}</a>`,
      ).join(" ");
      return html(`<p>${filler(3)}</p>${links}`);
    }
    case "sitemap-flood": {
      if (url.href !== generator.url) return undefined;
      const entries = Array.from(
        { length: generator.urls },
        (_, index) => `<url><loc>${url.origin}/flood/${index}</loc></url>`,
      ).join("");
      return new Response(`<urlset>${entries}</urlset>`, {
        headers: { "content-type": "application/xml" },
      });
    }
    case "gzip-bomb": {
      if (url.href !== generator.url) return undefined;
      const compressed = gzipSync(Buffer.alloc(generator.decodedBytes, 0x20));
      const count = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          counter.decoded += chunk.byteLength;
          done(null, chunk);
        },
      });
      const decoded = Readable.from([compressed]).pipe(createGunzip()).pipe(count);
      return new Response(Readable.toWeb(decoded) as ReadableStream<Uint8Array>, {
        headers: { "content-type": generator.contentType },
      });
    }
  }
}

export interface CrawlNetwork extends FakeNetwork {
  decodedBytes: () => number;
}

export function crawlNetwork(
  network: Network | undefined,
  generators: readonly CrawlGenerator[],
): CrawlNetwork {
  const base = fakeNetwork(network);
  const counter = { decoded: 0 };
  const fetchImpl: typeof fetch = (input, init) => {
    const url = requestUrl(input);
    for (const generator of generators) {
      const response = generated(generator, url, counter);
      if (response !== undefined) {
        base.requests.push(url);
        return Promise.resolve(response);
      }
    }
    return base.fetchImpl(input, init);
  };
  return { ...base, fetchImpl, decodedBytes: () => counter.decoded };
}
