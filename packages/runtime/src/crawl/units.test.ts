import { describe, expect, it } from "vitest";

import { HostWaitError, MAX_CRAWL_DELAY_MS } from "../tools/fetch";
import { DuplicateIndex, contentHash, hammingDistance, simhash } from "./dedupe";
import { Frontier } from "./frontier";
import { HostPoliteness } from "./politeness";
import { COMPANY_PROFILE, DOCS_PROFILE, scoreUrl } from "./priority";
import { TrapGuard } from "./traps";
import { nonContentReason, normaliseUrl, otherLocale, urlKey } from "./url";

describe("URL normalisation", () => {
  it("drops fragments, tracking and session parameters and sorts the query, keeping the path as served", () => {
    expect(
      normaliseUrl("https://Acme.example/Docs/index.html?utm_source=x&b=2&a=1&gclid=9#top"),
    ).toBe("https://acme.example/Docs/index.html?a=1&b=2");
    expect(normaliseUrl("https://acme.example/a//b/;jsessionid=abc")).toBe(
      "https://acme.example/a/b/",
    );
    expect(normaliseUrl("https://acme.example/about/")).toBe("https://acme.example/about/");
    expect(normaliseUrl("mailto:x@acme.example")).toBeUndefined();
    expect(normaliseUrl("/pricing", "https://acme.example/docs/")).toBe(
      "https://acme.example/pricing",
    );
  });

  it("keys www, scheme and path case variants together", () => {
    expect(urlKey("https://www.acme.example/About/")).toBe(urlKey("http://acme.example/about"));
    expect(urlKey("https://acme.example/docs/index.html")).toBe(
      urlKey("https://acme.example/docs"),
    );
  });

  it("skips assets, auth, cart, search and action URLs", () => {
    expect(nonContentReason("https://acme.example/logo.svg")).toBe("asset or binary");
    expect(nonContentReason("https://acme.example/cart")).toMatch(/cart/);
    expect(nonContentReason("https://acme.example/account/login")).toMatch(/auth/);
    expect(nonContentReason("https://acme.example/blog?s=robots")).toMatch(/search/);
    expect(nonContentReason("https://acme.example/shop?add-to-cart=12")).toMatch(/action/);
    expect(nonContentReason("https://acme.example/a?w=1&x=2&y=3&z=4")).toMatch(/too many/);
    expect(nonContentReason("https://acme.example/pricing")).toBeUndefined();
  });

  it("skips other locales unless the crawl started there", () => {
    const start = new URL("https://acme.example/");
    expect(otherLocale(new URL("https://acme.example/de/about"), start)).toBe(true);
    expect(otherLocale(new URL("https://acme.example/en-gb/about"), start)).toBe(false);
    expect(otherLocale(new URL("https://acme.example/vs/rival"), start)).toBe(false);
    expect(
      otherLocale(new URL("https://acme.example/de/about"), new URL("https://acme.example/de/")),
    ).toBe(false);
  });
});

describe("TrapGuard", () => {
  it("caps calendar pages, deep pagination, repeating paths and repetitive patterns", () => {
    const guard = new TrapGuard({ maxPerPattern: 5, maxCalendarPages: 2, maxPaginationPage: 3 });
    const calendar = Array.from({ length: 6 }, (_, month) =>
      guard.check(
        `https://acme.example/events/calendar/2026-${String(month + 1).padStart(2, "0")}`,
      ),
    );
    expect(calendar.filter((reason) => reason === undefined)).toHaveLength(2);
    expect(calendar.at(-1)).toBe("calendar trap");
    expect(guard.check("https://acme.example/events?month=2026-01")).toBeUndefined();
    expect(guard.check("https://acme.example/events?month=2026-02")).toBeUndefined();
    expect(guard.check("https://acme.example/events?month=2026-03")).toBe("calendar trap");
    expect(guard.check("https://acme.example/blog?page=3")).toBeUndefined();
    expect(guard.check("https://acme.example/blog?page=4")).toBe("deep pagination");
    expect(guard.check("https://acme.example/blog/page/9")).toBe("deep pagination");
    expect(guard.check("https://acme.example/a/b/a/b/a/b")).toBe("repeating path");
    const items = Array.from({ length: 7 }, (_, id) =>
      guard.check(`https://acme.example/item/${id}`),
    );
    expect(items.filter((reason) => reason === undefined)).toHaveLength(5);
    expect(guard.check("https://acme.example/blog/2024/05/launch-day")).toBeUndefined();
    expect(guard.check("https://acme.example/blog/2024/06/new-office")).toBeUndefined();
  });
});

describe("dedupe", () => {
  const base =
    "Acme Robotics builds autonomous picking robots for mid-size warehouses. Our fleet software runs on Kubernetes and integrates with SAP. Customers cut picking time by forty percent within one quarter, and support is available around the clock in English and German.";

  it("treats whitespace and case changes as the same content", () => {
    expect(contentHash(base)).toBe(contentHash(`  ${base.toUpperCase()}\n`));
  });

  it("flags near-duplicates by simhash and keeps different pages apart", () => {
    const near = base.replace("forty percent", "forty-one percent");
    const other =
      "Careers at Acme: we are hiring robotics engineers in Berlin and Austin, with remote options for software roles and a hardware lab in both offices.";
    expect(hammingDistance(simhash(base), simhash(near))).toBeLessThanOrEqual(6);
    expect(hammingDistance(simhash(base), simhash(other))).toBeGreaterThan(16);
    const index = new DuplicateIndex();
    index.add(contentHash(base), simhash(base), "https://acme.example/a");
    expect(index.find(contentHash(near), simhash(near))).toEqual({
      url: "https://acme.example/a",
      kind: "near",
    });
    expect(index.find(contentHash(base))).toEqual({ url: "https://acme.example/a", kind: "exact" });
    expect(index.find(contentHash(other), simhash(other))).toBeUndefined();
  });
});

describe("Frontier", () => {
  const entry = (url: string, score: number, depth = 1, host = "a.example") => ({
    url,
    key: url,
    host,
    depth,
    score,
    source: "link" as const,
  });

  it("pops the best score first, then the shallowest, then first-in, and dedupes", () => {
    const frontier = new Frontier(10);
    frontier.add(entry("low", 10));
    frontier.add(entry("high", 90));
    frontier.add(entry("deep", 50, 3));
    frontier.add(entry("shallow", 50, 1));
    frontier.add(entry("shallow-later", 50, 1));
    expect(frontier.add(entry("high", 99))).toBe(false);
    const order = [];
    for (
      let next = frontier.popBest(() => true);
      next !== undefined;
      next = frontier.popBest(() => true)
    )
      order.push(next.url);
    expect(order).toEqual(["high", "shallow", "shallow-later", "deep", "low"]);
  });

  it("only hands out entries for eligible hosts and respects its size cap", () => {
    const frontier = new Frontier(2);
    frontier.add(entry("x", 90, 1, "busy.example"));
    frontier.add(entry("y", 10, 1, "free.example"));
    expect(frontier.add(entry("z", 50, 1, "free.example"))).toBe(false);
    expect(frontier.popBest((host) => host !== "busy.example")?.url).toBe("y");
    expect(frontier.popBest((host) => host !== "busy.example")).toBeUndefined();
    expect(frontier.size).toBe(1);
  });
});

describe("priority", () => {
  const now = Date.parse("2026-11-25T00:00:00Z");
  const score = (url: string, extra: Partial<Parameters<typeof scoreUrl>[1]> = {}) =>
    scoreUrl(COMPANY_PROFILE, { url, depth: 1, source: "link", nowMs: now, ...extra });

  it("ranks company research pages above generic and deep ones", () => {
    expect(score("https://acme.example/pricing").topic).toBe("pricing");
    expect(score("https://acme.example/pricing").score).toBeGreaterThan(
      score("https://acme.example/random").score,
    );
    expect(score("https://acme.example/about").score).toBeGreaterThan(
      score("https://acme.example/blog/2019/old/post").score,
    );
    expect(score("https://acme.example/x", { anchorText: "Customers" }).topic).toBe("customers");
    expect(score("https://acme.example/de/pricing").score).toBeLessThan(
      score("https://acme.example/pricing").score,
    );
  });

  it("is configurable per mission", () => {
    const docs = scoreUrl(DOCS_PROFILE, {
      url: "https://acme.example/help/returns",
      depth: 2,
      source: "link",
      nowMs: now,
    });
    const careers = scoreUrl(DOCS_PROFILE, {
      url: "https://acme.example/careers",
      depth: 1,
      source: "link",
      nowMs: now,
    });
    expect(docs.topic).toBe("docs");
    expect(docs.score).toBeGreaterThan(careers.score);
  });
});

describe("HostPoliteness", () => {
  function clock() {
    let time = 0;
    return {
      now: () => time,
      sleep: (ms: number) => {
        time += ms;
        return Promise.resolve();
      },
    };
  }

  it("never lets more than the per-host limit run at once", async () => {
    const c = clock();
    const gate = new HostPoliteness({ perHost: 2, minIntervalMs: 0, ...c });
    const first = await gate.acquire("a.example");
    const second = await gate.acquire("a.example");
    let third = false;
    const pending = gate.acquire("a.example").then((release) => {
      third = true;
      return release;
    });
    await Promise.resolve();
    expect(third).toBe(false);
    expect(gate.capacity("a.example")).toBe(0);
    expect(gate.capacity("b.example")).toBe(2);
    first({ latencyMs: 10, status: 200 });
    (await pending)({ latencyMs: 10, status: 200 });
    second({ latencyMs: 10, status: 200 });
    expect(third).toBe(true);
    expect(gate.stats().find((host) => host.host === "a.example")?.peakActive).toBe(2);
  });

  it("spaces request starts by the interval and by Crawl-delay with one request at a time", async () => {
    const c = clock();
    const gate = new HostPoliteness({ perHost: 6, minIntervalMs: 100, ...c });
    (await gate.acquire("a.example"))({ latencyMs: 5 });
    expect(gate.readyIn("a.example")).toBe(100);
    gate.setCrawlDelay("a.example", 3_000);
    expect(gate.limit("a.example")).toBe(1);
    (await gate.acquire("a.example"))({ latencyMs: 5 });
    const before = c.now();
    (await gate.acquire("a.example"))({ latencyMs: 5 });
    expect(c.now() - before).toBe(3_000);
  });

  it("backs off on 429 using Retry-After and halves the host's concurrency", async () => {
    const c = clock();
    const gate = new HostPoliteness({ perHost: 6, minIntervalMs: 0, ...c });
    (await gate.acquire("a.example"))({ latencyMs: 20, status: 429, retryAfterMs: 5_000 });
    expect(gate.readyIn("a.example")).toBe(5_000);
    expect(gate.limit("a.example")).toBe(3);
    (await gate.acquire("a.example"))({ latencyMs: 20, status: 503 });
    expect(gate.limit("a.example")).toBe(1);
  });

  it("returns promptly when the caller aborts during a Crawl-delay wait", async () => {
    const gate = new HostPoliteness({ minIntervalMs: 0 });
    gate.setCrawlDelay("a.example", 2_000);
    (await gate.acquire("a.example"))({ latencyMs: 1 });
    const started = Date.now();
    const outcome = await gate.acquire("a.example", AbortSignal.timeout(50)).then(
      () => "acquired",
      (error: unknown) => (error instanceof HostWaitError ? error.reason : "other"),
    );
    expect(outcome).toBe("aborted");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("drops an aborted waiter so it never takes a slot", async () => {
    const gate = new HostPoliteness({ perHost: 1, minIntervalMs: 0 });
    const first = await gate.acquire("a.example");
    const controller = new AbortController();
    const waiting = gate.acquire("a.example", controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ reason: "aborted" });
    first({ latencyMs: 1 });
    expect(gate.capacity("a.example")).toBe(1);
    (await gate.acquire("a.example"))({ latencyMs: 1 });
    expect(gate.stats()[0]?.requests).toBe(2);
  });

  it("fails fast when the next slot is beyond the caller's wait budget", async () => {
    const c = clock();
    const gate = new HostPoliteness({ minIntervalMs: 0, ...c });
    (await gate.acquire("a.example"))({ latencyMs: 1, status: 429, retryAfterMs: 86_400_000 });
    await expect(gate.acquire("a.example", undefined, 15_000)).rejects.toMatchObject({
      reason: "too_late",
    });
    expect(c.now()).toBe(0);
  });

  it("never spaces a host further apart than the Crawl-delay cap", () => {
    const gate = new HostPoliteness({ minIntervalMs: 0 });
    gate.setCrawlDelay("a.example", 600_000);
    expect(gate.stats()[0]?.intervalMs).toBe(MAX_CRAWL_DELAY_MS);
  });

  it("slows down when latency climbs and recovers when the host is healthy again", async () => {
    const c = clock();
    const gate = new HostPoliteness({ perHost: 6, minIntervalMs: 0, ...c });
    for (let index = 0; index < 3; index += 1)
      (await gate.acquire("a.example"))({ latencyMs: 100 });
    for (let index = 0; index < 6; index += 1) {
      (await gate.acquire("a.example"))({ latencyMs: 4_000 });
      await c.sleep(5_000);
    }
    expect(gate.limit("a.example")).toBeLessThan(6);
    for (let index = 0; index < 60; index += 1)
      (await gate.acquire("a.example"))({ latencyMs: 100 });
    expect(gate.limit("a.example")).toBe(6);
  });
});
