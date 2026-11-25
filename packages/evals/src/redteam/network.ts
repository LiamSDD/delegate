import { FetchBlockedError, createFetcher, type Fetcher } from "@delegate/runtime/security";

import { type Network, type Route } from "./schema";

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
  const recorded = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof FetchBlockedError && SECURITY_FETCH_CODES.has(error.code))
        blocks.push(error.code);
      throw error;
    }
  };
  return {
    blocks,
    fetch: (request) => recorded(() => inner.fetch(request)),
    download: (request) => recorded(() => inner.download(request)),
    pagesFetched: () => inner.pagesFetched(),
    sitemapsFor: (url) => inner.sitemapsFor(url),
  };
}
