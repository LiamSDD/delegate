import { describe, expect, it } from "vitest";

import { BENCH_SITE, runBenchScenario, type BenchScenario } from "./bench";

const pages = BENCH_SITE.hosts * BENCH_SITE.pagesPerHost;

function scenario(workers: number, overrides: Partial<BenchScenario> = {}): BenchScenario {
  return {
    label: `${workers} workers`,
    workers,
    perHost: 6,
    minIntervalMs: 100,
    site: BENCH_SITE,
    maxPages: pages,
    ...overrides,
  };
}

describe("crawl benchmark on a fake network", { timeout: 60_000 }, () => {
  it("scales throughput with workers across hosts and never exceeds the per-host limit", async () => {
    const results = [];
    for (const workers of [1, 4, 16, 32]) results.push(await runBenchScenario(scenario(workers)));
    for (const result of results) {
      expect(result.pages).toBe(pages);
      expect(result.peakPerHost).toBeLessThanOrEqual(6);
    }
    const [one, four, sixteen, thirtyTwo] = results.map((result) => result.pagesPerSecond);
    expect(four).toBeGreaterThan((one ?? 0) * 3);
    expect(sixteen).toBeGreaterThan((four ?? 0) * 2);
    expect(thirtyTwo).toBeGreaterThan((sixteen ?? 0) * 1.3);
  });

  it("is deterministic", async () => {
    const first = await runBenchScenario(scenario(8));
    const second = await runBenchScenario(scenario(8));
    expect(second.virtualSeconds).toBe(first.virtualSeconds);
    expect(second.requests).toBe(first.requests);
  });

  it("gets its single-site speed from per-host parallelism, capped by the polite interval", async () => {
    const result = await runBenchScenario(
      scenario(32, { site: { hosts: 1, pagesPerHost: 120, latencyMs: 250 }, maxPages: 120 }),
    );
    expect(result.peakPerHost).toBeLessThanOrEqual(6);
    expect(result.pagesPerSecond).toBeLessThanOrEqual(10.5);
    expect(result.pagesPerSecond).toBeGreaterThan(8);
  });

  it("caps a slow site at the per-host concurrency limit", async () => {
    const result = await runBenchScenario(
      scenario(32, { site: { hosts: 1, pagesPerHost: 60, latencyMs: 1_500 }, maxPages: 60 }),
    );
    expect(result.peakPerHost).toBe(6);
    expect(result.pagesPerSecond).toBeLessThanOrEqual(4.1);
  });

  it("honours Crawl-delay with one request at a time", async () => {
    const result = await runBenchScenario(
      scenario(32, {
        site: { hosts: 1, pagesPerHost: 10, latencyMs: 50, crawlDelaySeconds: 2 },
        maxPages: 10,
      }),
    );
    expect(result.pages).toBe(10);
    expect(result.peakPerHost).toBe(1);
    expect(result.virtualSeconds).toBeGreaterThanOrEqual(18);
  });

  it("backs off on 429 with Retry-After and still finishes", async () => {
    const result = await runBenchScenario(
      scenario(32, {
        site: { hosts: 1, pagesPerHost: 40, latencyMs: 100, rateLimitEvery: 10 },
        maxPages: 40,
      }),
    );
    expect(result.pages).toBe(40);
    expect(result.result.stats.retries).toBeGreaterThan(0);
    const host = result.result.hosts[0];
    expect(host?.rateLimited).toBeGreaterThan(0);
    expect(result.virtualSeconds).toBeGreaterThan(6);
  });
});
