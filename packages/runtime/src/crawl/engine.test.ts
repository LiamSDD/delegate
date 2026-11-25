import { describe, expect, it } from "vitest";

import { createFetcher } from "../tools/fetch";
import { siteScope } from "../tools/research";
import { type CrawlCheckpoint } from "./checkpoint";
import { crawl, type CrawlOptions } from "./engine";
import { HostPoliteness } from "./politeness";

const ORIGIN = "https://www.acme.example";

function words(seed: number, count = 70): string {
  let state = seed;
  return Array.from({ length: count }, () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return `w${state % 700}`;
  }).join(" ");
}

function page(title: string, body: string, head = ""): string {
  return `<!doctype html><html lang="en"><head><title>${title}</title>${head}</head><body><nav><a href="/">Home</a> <a href="/pricing">Pricing</a> <a href="/about">About</a></nav><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
}

type Route = () => Response;

function html(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function xml(body: string): Response {
  return new Response(body, { headers: { "content-type": "application/xml" } });
}

function site(routes: Record<string, Route>, robots = "User-agent: *\nDisallow: /private\n") {
  const requested: string[] = [];
  const fetchImpl: typeof fetch = (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requested.push(url.href);
    if (url.pathname === "/robots.txt")
      return Promise.resolve(new Response(robots, { headers: { "content-type": "text/plain" } }));
    const route = routes[url.href];
    return Promise.resolve(
      route === undefined ? new Response("missing", { status: 404 }) : route(),
    );
  };
  const fetcher = createFetcher({
    fetchImpl,
    resolveDns: (host) =>
      Promise.resolve(host === "intranet.acme.example" ? ["10.0.0.7"] : ["93.184.215.14"]),
    sleep: () => Promise.resolve(),
    perHostIntervalMs: 0,
    maxPages: 500,
  });
  return { fetcher, requested };
}

function options(
  fetcher: ReturnType<typeof site>["fetcher"],
  extra: Partial<CrawlOptions> = {},
): CrawlOptions {
  return {
    fetcher,
    seeds: [`${ORIGIN}/`],
    scope: (url) => siteScope(ORIGIN).contains(url),
    politeness: new HostPoliteness({ minIntervalMs: 0 }),
    onPage: () => Promise.resolve(true),
    ...extra,
  };
}

const BASE_ROUTES: Record<string, Route> = {
  [`${ORIGIN}/`]: () =>
    html(
      page(
        "Acme",
        `${words(1)} <a href="/blog/a">A</a> <a href="/private/plan">secret</a> <a href="/cart">cart</a> <a href="https://evil.example/x">x</a> <a href="/logo.png">logo</a>`,
        '<link rel="alternate" type="application/rss+xml" href="/feed.xml">',
      ),
    ),
  [`${ORIGIN}/sitemap.xml`]: () =>
    xml(
      `<sitemapindex><sitemap><loc>${ORIGIN}/sitemap-old.xml</loc><lastmod>2019-01-01</lastmod></sitemap><sitemap><loc>${ORIGIN}/sitemap-pages.xml</loc><lastmod>2026-11-01</lastmod></sitemap><sitemap><loc>http://intranet.acme.example/sitemap.xml</loc></sitemap><sitemap><loc>http://localhost/sitemap.xml</loc></sitemap></sitemapindex>`,
    ),
  [`${ORIGIN}/sitemap-pages.xml`]: () =>
    xml(
      `<urlset>${["/pricing", "/about", "/customers", "/blog/2019/01/old-news", "/private/roadmap", "http://169.254.169.254/latest"].map((path) => `<url><loc>${path.startsWith("http") ? path : `${ORIGIN}${path}`}</loc><lastmod>2026-10-01</lastmod></url>`).join("")}</urlset>`,
    ),
  [`${ORIGIN}/sitemap-old.xml`]: () =>
    xml(`<urlset><url><loc>${ORIGIN}/legacy</loc></url></urlset>`),
  [`${ORIGIN}/pricing`]: () => html(page("Pricing", words(2))),
  [`${ORIGIN}/about`]: () => html(page("About", words(3))),
  [`${ORIGIN}/customers`]: () => html(page("Customers", words(4))),
  [`${ORIGIN}/legacy`]: () => html(page("Legacy", words(5))),
  [`${ORIGIN}/blog/a`]: () => html(page("Blog A", words(6))),
  [`${ORIGIN}/blog/2019/01/old-news`]: () => html(page("Old news", words(7))),
  [`${ORIGIN}/feed.xml`]: () =>
    xml(
      `<rss><channel><item><title>Launch</title><link>${ORIGIN}/news/launch</link><pubDate>Tue, 03 Nov 2026 09:00:00 GMT</pubDate></item></channel></rss>`,
    ),
  [`${ORIGIN}/news/launch`]: () => html(page("Launch", words(8))),
};

describe("crawl engine", () => {
  it("discovers URLs from nested sitemaps, robots and feeds, and keeps every guard on", async () => {
    const { fetcher, requested } = site(BASE_ROUTES);
    const result = await crawl(options(fetcher, { budget: { maxPages: 20 } }));
    const urls = result.pages.map((entry) => entry.url);
    expect(urls[0]).toBe(`${ORIGIN}/`);
    for (const path of ["/pricing", "/about", "/customers", "/legacy", "/blog/a", "/news/launch"])
      expect(urls).toContain(`${ORIGIN}${path}`);
    expect(requested.some((url) => url.includes("/private/"))).toBe(false);
    expect(requested.some((url) => /intranet|localhost|169\.254|evil\.example/.test(url))).toBe(
      false,
    );
    expect(requested.some((url) => url.endsWith(".png") || url.endsWith("/cart"))).toBe(false);
    expect(result.stats.skippedByCode).toMatchObject({
      robots: 2,
      scope: 3,
      non_content: 2,
      "fetch:blocked_address": 1,
    });
    expect(result.stats.sitemapsFetched).toBe(5);
    expect(result.stats.feedsFetched).toBe(1);
    expect(result.stopReason).toBe("exhausted");
  });

  it("orders the queue by mission relevance, so the research pages come first", async () => {
    const { fetcher } = site(BASE_ROUTES);
    const result = await crawl(options(fetcher, { concurrency: 1, budget: { maxPages: 4 } }));
    expect(
      result.pages
        .map((entry) => entry.url)
        .slice(1)
        .sort(),
    ).toEqual([`${ORIGIN}/about`, `${ORIGIN}/customers`, `${ORIGIN}/pricing`].sort());
    expect(result.stopReason).toBe("page_budget");
  });

  it("dedupes redirects, canonical URLs, exact copies and near-duplicates, and honours noindex", async () => {
    const shared = words(42, 120);
    const { fetcher } = site({
      [`${ORIGIN}/`]: () =>
        html(
          page(
            "Home",
            `${words(9)} <a href="/a">a</a> <a href="/b">b</a> <a href="/c">c</a> <a href="/d">d</a> <a href="/e">e</a> <a href="/f">f</a>`,
          ),
        ),
      [`${ORIGIN}/a`]: () => html(page("A", shared)),
      [`${ORIGIN}/b`]: () =>
        new Response(null, { status: 301, headers: { location: `${ORIGIN}/a` } }),
      [`${ORIGIN}/c`]: () => html(page("C", shared, `<link rel="canonical" href="${ORIGIN}/a">`)),
      [`${ORIGIN}/d`]: () => html(page("D", shared)),
      [`${ORIGIN}/e`]: () => html(page("E", `${shared} w1 w2`)),
      [`${ORIGIN}/f`]: () => html(page("F", words(11), '<meta name="robots" content="noindex">')),
    });
    const result = await crawl(options(fetcher, { concurrency: 1 }));
    expect(result.pages.map((entry) => entry.url)).toEqual([`${ORIGIN}/`, `${ORIGIN}/a`]);
    expect(result.stats.skippedByCode).toMatchObject({
      duplicate: 2,
      near_duplicate: 2,
      noindex: 1,
    });
  });

  it("contains an infinite calendar and a link flood", async () => {
    const calendar = (month: number) => {
      const next = `/events/calendar?month=${month + 1}`;
      return html(page(`Events ${month}`, `${words(100 + month)} <a href="${next}">next</a>`));
    };
    const routes: Record<string, Route> = {
      [`${ORIGIN}/`]: () =>
        html(
          page(
            "Home",
            `${words(12)} <a href="/events/calendar?month=1">events</a> ${Array.from({ length: 5_000 }, (_, index) => `<a href="/l/${index}">l</a>`).join(" ")}`,
          ),
        ),
    };
    for (let month = 1; month < 400; month += 1)
      routes[`${ORIGIN}/events/calendar?month=${month}`] = () => calendar(month);
    for (let index = 0; index < 5_000; index += 1)
      routes[`${ORIGIN}/l/${index}`] = () => html(page(`L ${index}`, words(1_000 + index)));
    const { fetcher, requested } = site(routes);
    const result = await crawl(
      options(fetcher, { budget: { maxPages: 500, maxLinksPerPage: 100, maxPerPattern: 30 } }),
    );
    expect(requested.filter((url) => url.includes("/events/")).length).toBeLessThanOrEqual(3);
    expect(requested.filter((url) => url.includes("/l/")).length).toBeLessThanOrEqual(30);
    expect(result.stats.skippedByCode).toMatchObject({ link_cap: 1 });
    expect(result.stats.skippedByCode.trap).toBeGreaterThan(0);
  });

  it("checkpoints and resumes without fetching any page twice", async () => {
    const routes: Record<string, Route> = {
      [`${ORIGIN}/`]: () =>
        html(
          page(
            "Home",
            `${words(13)} ${Array.from({ length: 12 }, (_, index) => `<a href="/docs/p${index}">p${index}</a>`).join(" ")}`,
          ),
        ),
      [`${ORIGIN}/sitemap.xml`]: () =>
        xml(`<urlset><url><loc>${ORIGIN}/pricing</loc></url></urlset>`),
      [`${ORIGIN}/pricing`]: () => html(page("Pricing", words(14))),
    };
    for (let index = 0; index < 12; index += 1)
      routes[`${ORIGIN}/docs/p${index}`] = () => html(page(`P${index}`, words(200 + index)));
    const first = site(routes);
    const saved: CrawlCheckpoint[] = [];
    const cut = await crawl(
      options(first.fetcher, {
        concurrency: 2,
        budget: { maxPages: 6 },
        checkpointEveryPages: 2,
        onCheckpoint: (checkpoint) => {
          saved.push(checkpoint);
          return Promise.resolve();
        },
      }),
    );
    expect(cut.pages).toHaveLength(6);
    expect(saved.length).toBeGreaterThanOrEqual(3);
    const checkpoint = saved.at(-1);
    if (checkpoint === undefined) throw new Error("no checkpoint");
    const restored: CrawlCheckpoint = JSON.parse(JSON.stringify(checkpoint)) as CrawlCheckpoint;
    const second = site(routes);
    const resumed = await crawl(
      options(second.fetcher, { checkpoint: restored, budget: { maxPages: 50 } }),
    );
    expect(resumed.pages).toHaveLength(14);
    const refetched = second.requested.filter(
      (url) => first.requested.includes(url) && !url.endsWith("/robots.txt"),
    );
    expect(refetched).toEqual([]);
    expect(second.requested.some((url) => url.endsWith("sitemap.xml"))).toBe(false);
  });

  it("stops at the time budget and puts in-flight pages back on the queue", async () => {
    let time = 0;
    const slow: typeof fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/robots.txt") return new Response("", { status: 404 });
      await new Promise((resolve) => setTimeout(resolve, 5));
      time += 400;
      if (url.pathname === "/")
        return html(page("Home", `${words(15)} <a href="/x">x</a> <a href="/y">y</a>`));
      return html(page(url.pathname, words(url.pathname.length * 31)));
    };
    const fetcher = createFetcher({
      fetchImpl: slow,
      resolveDns: () => Promise.resolve(["93.184.215.14"]),
      sleep: () => Promise.resolve(),
      perHostIntervalMs: 0,
    });
    const result = await crawl(
      options(fetcher, {
        now: () => time,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
        budget: { maxDurationMs: 1_000 },
      }),
    );
    expect(result.stopReason).toBe("time_budget");
    expect(result.checkpoint.frontier.length + result.pages.length).toBeGreaterThanOrEqual(2);
  });
});
