import { describe, expect, it } from "vitest";

import {
  FetchBlockedError,
  USER_AGENT,
  createFetcher,
  parseRetryAfter,
  type FetcherOptions,
  type HostGate,
  type HostOutcome,
} from "./fetch";
import { HostPoliteness } from "../crawl/politeness";

type Handler = (url: URL, init: RequestInit | undefined) => Response;

interface Harness {
  calls: { url: string; init: RequestInit | undefined }[];
  sleeps: number[];
  options: FetcherOptions;
}

function html(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    ...init,
  });
}

function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

function harness(
  routes: Record<string, Handler>,
  dns: Record<string, string[] | (() => string[])> = {},
  overrides: Partial<FetcherOptions> = {},
): Harness {
  const calls: Harness["calls"] = [];
  const sleeps: number[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ url: url.href, init });
    const handler = routes[url.href] ?? routes[`${url.origin}/*`];
    if (handler !== undefined) return Promise.resolve(handler(url, init));
    if (url.pathname === "/robots.txt") return Promise.resolve(new Response("", { status: 404 }));
    return Promise.resolve(new Response("missing", { status: 404 }));
  };
  const resolveDns = (host: string) => {
    const entry = dns[host];
    if (entry === undefined) return Promise.resolve(["93.184.216.34"]);
    return Promise.resolve(typeof entry === "function" ? entry() : entry);
  };
  return {
    calls,
    sleeps,
    options: {
      fetchImpl,
      resolveDns,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      ...overrides,
    },
  };
}

async function blockedCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof FetchBlockedError) return error.code;
    throw error;
  }
  throw new Error("expected the fetch to be blocked");
}

function slowBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("<p>start"));
    },
    pull: () => new Promise<void>(() => undefined),
  });
}

function endlessBody(chunkBytes: number): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(chunkBytes).fill(97);
  return new ReadableStream({
    pull(controller) {
      controller.enqueue(chunk);
    },
  });
}

describe("SSRF matrix", () => {
  const literalCases: [string, string][] = [
    ["shorthand IPv4 loopback", "http://127.1/"],
    ["hex IPv4 loopback", "http://0x7f.1/"],
    ["decimal IPv4 loopback", "http://2130706433/"],
    ["IPv6 loopback", "http://[::1]/"],
    ["IPv4-mapped IPv6 loopback", "http://[::ffff:127.0.0.1]/"],
    ["cloud metadata address", "http://169.254.169.254/latest/meta-data/"],
    ["private IPv4 literal", "http://10.0.0.1/"],
    ["unspecified address", "http://0.0.0.0/"],
  ];

  it.each(literalCases)("rejects %s without any request", async (_name, url) => {
    const h = harness({});
    expect(await blockedCode(createFetcher(h.options).fetch({ url }))).toBe("ip_literal");
    expect(h.calls).toHaveLength(0);
  });

  it.each([
    ["metadata hostname", "http://metadata.google.internal/computeMetadata/v1/"],
    ["localhost", "http://localhost:80/"],
    ["single-label host", "http://intranet/"],
    ["mDNS name", "http://printer.local/"],
  ])("rejects %s by name", async (_name, url) => {
    const h = harness({});
    expect(await blockedCode(createFetcher(h.options).fetch({ url }))).toBe("blocked_host");
    expect(h.calls).toHaveLength(0);
  });

  it.each([
    ["10/8", ["10.1.2.3"]],
    ["172.16/12", ["172.20.0.9"]],
    ["192.168/16", ["192.168.0.10"]],
    ["100.64/10 CGNAT", ["100.64.0.7"]],
    ["169.254/16 link-local", ["169.254.169.254"]],
    ["127/8 loopback", ["127.0.0.53"]],
    ["fc00::/7 unique local", ["fd00::5"]],
    ["fe80::/10 link-local", ["fe80::1"]],
    ["IPv4-mapped private", ["::ffff:10.0.0.1"]],
    ["mixed public and private answers", ["93.184.216.34", "10.0.0.2"]],
    ["empty answer", []],
  ])("rejects a name resolving into %s", async (_name, addresses) => {
    const h = harness({}, { "evil.example": addresses });
    const code = await blockedCode(
      createFetcher(h.options).fetch({ url: "https://evil.example/" }),
    );
    expect(["blocked_address", "dns_failed"]).toContain(code);
    expect(h.calls).toHaveLength(0);
  });

  it("rejects a redirect into private IP space", async () => {
    const h = harness({ "https://acme.example/": () => redirect("http://10.0.0.1/admin") });
    expect(
      await blockedCode(createFetcher(h.options).fetch({ url: "https://acme.example/" })),
    ).toBe("ip_literal");
    expect(h.calls.map((call) => call.url)).not.toContain("http://10.0.0.1/admin");
  });

  it("rejects a redirect to a name that resolves privately", async () => {
    const h = harness(
      { "https://acme.example/": () => redirect("https://internal.acme.example/") },
      { "internal.acme.example": ["192.168.1.20"] },
    );
    expect(
      await blockedCode(createFetcher(h.options).fetch({ url: "https://acme.example/" })),
    ).toBe("blocked_address");
  });

  it("re-resolves on every hop, defeating DNS rebinding", async () => {
    const answers = [["93.184.216.34"], ["93.184.216.34"], ["127.0.0.1"]];
    let index = 0;
    const h = harness(
      { "https://rebind.example/": () => redirect("https://rebind.example/next") },
      { "rebind.example": () => answers[Math.min(index++, answers.length - 1)] ?? [] },
    );
    expect(
      await blockedCode(createFetcher(h.options).fetch({ url: "https://rebind.example/" })),
    ).toBe("blocked_address");
    expect(h.calls.map((call) => call.url)).not.toContain("https://rebind.example/next");
  });

  it("rejects credentials in the URL", async () => {
    const h = harness({});
    expect(
      await blockedCode(
        createFetcher(h.options).fetch({ url: "https://user:secret@acme.example/" }),
      ),
    ).toBe("credentials");
  });

  it.each([
    "file:///etc/passwd",
    "ftp://acme.example/",
    "gopher://acme.example/",
    "data:text/html,hi",
  ])("rejects non-http scheme %s", async (url) => {
    const h = harness({});
    expect(await blockedCode(createFetcher(h.options).fetch({ url }))).toBe("scheme");
  });

  it("rejects non-default ports", async () => {
    const h = harness({});
    expect(
      await blockedCode(createFetcher(h.options).fetch({ url: "https://acme.example:8443/" })),
    ).toBe("port");
  });

  it("keeps the first maxBytes of an oversize body and marks it truncated", async () => {
    const h = harness({
      "https://acme.example/": () =>
        new Response(endlessBody(64 * 1024), { headers: { "content-type": "text/html" } }),
    });
    const document = await createFetcher({ ...h.options, maxBytes: 100_000 }).fetch({
      url: "https://acme.example/",
    });
    expect(document.bytes).toBe(100_000);
    expect(document.truncated).toBe(true);
  });

  it("reads a page whose declared length exceeds the cap instead of refusing it", async () => {
    const h = harness({
      "https://acme.example/": () =>
        html("small", { headers: { "content-type": "text/html", "content-length": "5000000" } }),
    });
    const document = await createFetcher(h.options).fetch({ url: "https://acme.example/" });
    expect(document.text).toContain("small");
    expect(document.truncated).toBeUndefined();
  });

  it("times out a slow body", async () => {
    const h = harness(
      {
        "https://acme.example/": () =>
          new Response(slowBody(), { headers: { "content-type": "text/html" } }),
      },
      {},
      { timeoutMs: 40 },
    );
    expect(
      await blockedCode(createFetcher(h.options).fetch({ url: "https://acme.example/" })),
    ).toBe("timeout");
  });

  it("caps redirects at five hops", async () => {
    const routes: Record<string, Handler> = {};
    for (let hop = 0; hop < 7; hop += 1) {
      routes[`https://acme.example/${hop}`] = () => redirect(`/${hop + 1}`, 301);
    }
    const h = harness(routes);
    expect(
      await blockedCode(createFetcher(h.options).fetch({ url: "https://acme.example/0" })),
    ).toBe("too_many_redirects");
  });

  it("only accepts html, text, xml and json", async () => {
    const h = harness({
      "https://acme.example/file": () =>
        new Response("bin", { headers: { "content-type": "application/octet-stream" } }),
    });
    expect(
      await blockedCode(createFetcher(h.options).fetch({ url: "https://acme.example/file" })),
    ).toBe("content_type");
  });

  it("allows public IP literals only when opted in, never private ones", async () => {
    const h = harness(
      { "http://93.184.216.34/": () => html("<p>hi</p>") },
      {},
      {
        allowPublicIpLiterals: true,
      },
    );
    const fetcher = createFetcher(h.options);
    await expect(fetcher.fetch({ url: "http://93.184.216.34/" })).resolves.toMatchObject({
      status: 200,
    });
    expect(await blockedCode(fetcher.fetch({ url: "http://127.0.0.1/" }))).toBe("blocked_address");
  });
});

describe("fetcher behaviour", () => {
  it("sends an honest user agent, manual redirects and returns the text", async () => {
    const h = harness({ "https://acme.example/": () => html("<h1>Acme</h1>") });
    const document = await createFetcher({
      ...h.options,
      now: () => new Date("2026-11-24T10:00:00Z"),
    }).fetch({ url: "https://acme.example/" });
    expect(document).toMatchObject({
      url: "https://acme.example/",
      finalUrl: "https://acme.example/",
      status: 200,
      contentType: "text/html",
      text: "<h1>Acme</h1>",
      fetchedAt: "2026-11-24T10:00:00.000Z",
    });
    const pageCall = h.calls.find((call) => call.url === "https://acme.example/");
    expect(new Headers(pageCall?.init?.headers).get("user-agent")).toBe(USER_AGENT);
    expect(pageCall?.init?.redirect).toBe("manual");
  });

  it("follows a safe redirect and reports the final URL", async () => {
    const h = harness({
      "https://acme.example/": () => redirect("https://www.acme.example/home"),
      "https://www.acme.example/home": () => html("<p>home</p>"),
    });
    const document = await createFetcher(h.options).fetch({ url: "https://acme.example/" });
    expect(document.finalUrl).toBe("https://www.acme.example/home");
  });

  it("honours robots.txt and caches it per host", async () => {
    const h = harness({
      "https://acme.example/robots.txt": () =>
        new Response("User-agent: *\nDisallow: /private\n", {
          headers: { "content-type": "text/plain" },
        }),
      "https://acme.example/*": () => html("<p>ok</p>"),
    });
    const fetcher = createFetcher(h.options);
    expect(await blockedCode(fetcher.fetch({ url: "https://acme.example/private/x" }))).toBe(
      "robots",
    );
    await fetcher.fetch({ url: "https://acme.example/about" });
    expect(h.calls.filter((call) => call.url.endsWith("/robots.txt"))).toHaveLength(1);
  });

  it("treats an unreachable robots.txt as disallow and a missing one as allow", async () => {
    const down = harness({
      "https://down.example/robots.txt": () => new Response("oops", { status: 503 }),
    });
    expect(
      await blockedCode(createFetcher(down.options).fetch({ url: "https://down.example/" })),
    ).toBe("robots");
    const missing = harness({ "https://acme.example/": () => html("ok") });
    await expect(
      createFetcher(missing.options).fetch({ url: "https://acme.example/" }),
    ).resolves.toMatchObject({ status: 200 });
  });

  it("exposes sitemap directives from robots.txt", async () => {
    const h = harness({
      "https://acme.example/robots.txt": () =>
        new Response("Sitemap: https://acme.example/sitemap_index.xml\nUser-agent: *\nDisallow:\n"),
    });
    await expect(createFetcher(h.options).sitemapsFor("https://acme.example/x")).resolves.toEqual([
      "https://acme.example/sitemap_index.xml",
    ]);
  });

  it("can skip robots for documented public APIs", async () => {
    const h = harness({
      "https://api.example/robots.txt": () => new Response("User-agent: *\nDisallow: /\n"),
      "https://api.example/v1": () =>
        new Response("{}", { headers: { "content-type": "application/json" } }),
    });
    await expect(
      createFetcher(h.options).fetch({ url: "https://api.example/v1", respectRobots: false }),
    ).resolves.toMatchObject({ text: "{}" });
  });

  it("spaces requests to the same host one second apart, robots.txt included", async () => {
    const h = harness(
      { "https://acme.example/*": () => html("ok") },
      {},
      {
        now: () => new Date(0),
      },
    );
    const fetcher = createFetcher(h.options);
    await Promise.all([
      fetcher.fetch({ url: "https://acme.example/a" }),
      fetcher.fetch({ url: "https://acme.example/b" }),
      fetcher.fetch({ url: "https://acme.example/c" }),
    ]);
    expect(h.sleeps.filter((ms) => ms > 0).sort((a, b) => a - b)).toEqual([1000, 2000, 3000]);
  });

  it("routes every hop through the host gate and reports outcomes, Retry-After and Crawl-delay", async () => {
    const acquired: string[] = [];
    const outcomes: HostOutcome[] = [];
    const delays: [string, number][] = [];
    const gate: HostGate = {
      acquire: (host) => {
        acquired.push(host);
        return Promise.resolve((outcome) => {
          outcomes.push(outcome);
        });
      },
      setCrawlDelay: (host, ms) => {
        delays.push([host, ms]);
      },
    };
    const h = harness(
      {
        "https://acme.example/robots.txt": () =>
          new Response("User-agent: *\nCrawl-delay: 2\n", {
            headers: { "content-type": "text/plain" },
          }),
        "https://acme.example/old": () => redirect("https://docs.acme.example/new"),
        "https://docs.acme.example/new": () => html("ok"),
        "https://acme.example/busy": () =>
          new Response("slow down", { status: 429, headers: { "retry-after": "7" } }),
      },
      {},
      { hostGate: gate },
    );
    const fetcher = createFetcher(h.options);
    expect(fetcher.gate).toBe(gate);
    await fetcher.fetch({ url: "https://acme.example/old" });
    expect(acquired).toEqual([
      "acme.example",
      "acme.example",
      "docs.acme.example",
      "docs.acme.example",
    ]);
    expect(delays).toEqual([["acme.example", 2000]]);
    const error = await fetcher
      .fetch({ url: "https://acme.example/busy" })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "http_error", status: 429, retryAfterMs: 7000 });
    expect(outcomes.at(-1)).toMatchObject({ status: 429, retryAfterMs: 7000, failed: true });
    expect(h.sleeps).toEqual([]);
  });

  it("reports a content-type refusal to the host gate as a success, not a host failure", async () => {
    const outcomes: HostOutcome[] = [];
    const gate: HostGate = {
      acquire: () =>
        Promise.resolve((outcome) => {
          outcomes.push(outcome);
        }),
      setCrawlDelay: () => undefined,
    };
    const h = harness(
      {
        "https://acme.example/logo": () =>
          new Response("png", { headers: { "content-type": "image/png" } }),
      },
      {},
      { hostGate: gate },
    );
    const error = await createFetcher(h.options)
      .fetch({ url: "https://acme.example/logo" })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "content_type" });
    expect(outcomes.at(-1)).toMatchObject({ status: 200 });
    expect(outcomes.at(-1)?.failed).toBeUndefined();
  });

  it("skips a host whose Crawl-delay is longer than the cap and says why", async () => {
    const delays: number[] = [];
    const gate: HostGate = {
      acquire: () => Promise.resolve(() => undefined),
      setCrawlDelay: (_host, ms) => {
        delays.push(ms);
      },
    };
    const h = harness(
      {
        "https://slow.example/robots.txt": () =>
          new Response("User-agent: *\nCrawl-delay: 600\n", {
            headers: { "content-type": "text/plain" },
          }),
        "https://slow.example/page": () => html("ok"),
      },
      {},
      { hostGate: gate },
    );
    const error = await createFetcher(h.options)
      .fetch({ url: "https://slow.example/page" })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "crawl_delay" });
    expect(error instanceof Error ? error.message : "").toMatch(/crawl-delay 600 s/i);
    expect(delays).toEqual([]);
    expect(h.calls.map((call) => call.url)).toEqual(["https://slow.example/robots.txt"]);
  });

  it("fails a later fetch fast instead of sleeping out a day-long Retry-After", async () => {
    const h = harness(
      {
        "https://busy.example/a": () =>
          new Response("slow down", { status: 429, headers: { "retry-after": "86400" } }),
        "https://busy.example/b": () => html("ok"),
      },
      {},
      { hostGate: new HostPoliteness({ minIntervalMs: 0 }), timeoutMs: 15_000 },
    );
    const fetcher = createFetcher(h.options);
    await fetcher.fetch({ url: "https://busy.example/a" }).catch(() => undefined);
    const started = Date.now();
    const error = await fetcher
      .fetch({ url: "https://busy.example/b" })
      .catch((caught: unknown) => caught);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(error).toMatchObject({ code: "host_busy" });
    expect(h.calls.some((call) => call.url === "https://busy.example/b")).toBe(false);
  });

  it("parses Retry-After as seconds or an HTTP date", () => {
    const now = Date.parse("2026-11-25T10:00:00Z");
    expect(parseRetryAfter("120", now)).toBe(120_000);
    expect(parseRetryAfter("Wed, 25 Nov 2026 10:00:30 GMT", now)).toBe(30_000);
    expect(parseRetryAfter("soon", now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });

  it("enforces the per-run page cap", async () => {
    const h = harness({ "https://acme.example/*": () => html("ok") }, {}, { maxPages: 2 });
    const fetcher = createFetcher(h.options);
    await fetcher.fetch({ url: "https://acme.example/1" });
    await fetcher.fetch({ url: "https://acme.example/2" });
    expect(await blockedCode(fetcher.fetch({ url: "https://acme.example/3" }))).toBe("page_cap");
    expect(fetcher.pagesFetched()).toBe(2);
  });

  it("reports HTTP errors with their status", async () => {
    const h = harness({ "https://acme.example/gone": () => new Response("x", { status: 410 }) });
    const error = await createFetcher(h.options)
      .fetch({ url: "https://acme.example/gone" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FetchBlockedError);
    expect(error).toMatchObject({ code: "http_error", status: 410 });
  });

  it("aborts when the caller's signal fires", async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness({ "https://acme.example/": () => html("ok") });
    expect(
      await blockedCode(
        createFetcher(h.options).fetch({ url: "https://acme.example/", signal: controller.signal }),
      ),
    ).toBe("aborted");
  });
});

describe("download", () => {
  const gzip = (size: number) =>
    new Response(new Uint8Array(size).fill(7), {
      status: 200,
      headers: { "content-type": "application/x-gzip" },
    });
  const request = {
    url: "https://codeload.example/acme/widget/tar.gz/HEAD",
    accept: "application/x-gzip",
    contentTypes: [/^application\/(x-)?gzip$/],
    maxBytes: 1_000,
  };

  it("returns the raw bytes of an allowed binary type", async () => {
    const h = harness({ [request.url]: () => gzip(1_000) });
    const file = await createFetcher(h.options).download(request);
    expect(file.bytes.byteLength).toBe(1_000);
    expect(file.contentType).toBe("application/x-gzip");
  });

  it("refuses a body over the byte cap instead of truncating it", async () => {
    const h = harness({ [request.url]: () => gzip(1_001) });
    expect(await blockedCode(createFetcher(h.options).download(request))).toBe("too_large");
  });

  it("refuses content types outside the request's list and keeps the SSRF checks", async () => {
    const blocked = harness(
      { [request.url]: () => html("<html></html>") },
      { "codeload.example": ["10.0.0.5"] },
    );
    expect(await blockedCode(createFetcher(blocked.options).download(request))).toBe(
      "blocked_address",
    );
    const ok = harness({ [request.url]: () => html("<html></html>") });
    expect(await blockedCode(createFetcher(ok.options).download(request))).toBe("content_type");
  });
});
