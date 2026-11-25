import { createFetcher } from "../tools/fetch";
import { crawl, type CrawlResult } from "./engine";
import { HostPoliteness } from "./politeness";
import { DOCS_PROFILE } from "./priority";

interface Timer {
  at: number;
  seq: number;
  resolve: () => void;
}

export class VirtualClock {
  private time = 0;
  private seq = 0;
  private readonly timers: Timer[] = [];

  now = (): number => this.time;

  sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      this.timers.push({ at: this.time + Math.max(0, ms), seq: this.seq++, resolve });
    });

  async run<T>(work: Promise<T>): Promise<T> {
    const state: { settled: boolean; value?: T; failure?: unknown; failed: boolean } = {
      settled: false,
      failed: false,
    };
    work.then(
      (result) => {
        state.settled = true;
        state.value = result;
      },
      (error: unknown) => {
        state.settled = true;
        state.failed = true;
        state.failure = error;
      },
    );
    for (;;) {
      for (let turn = 0; turn < 4; turn += 1)
        await new Promise<void>((resolve) => setImmediate(resolve));
      if (state.settled) break;
      if (this.timers.length === 0) throw new Error("Virtual clock deadlock: nothing scheduled");
      this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.timers[0];
      if (next === undefined) break;
      this.time = Math.max(this.time, next.at);
      const due = this.timers.filter((timer) => timer.at <= this.time);
      this.timers.splice(0, due.length);
      for (const timer of due) timer.resolve();
    }
    if (state.failed)
      throw state.failure instanceof Error ? state.failure : new Error("Virtual run failed");
    return state.value as T;
  }
}

export interface FakeSiteOptions {
  hosts: number;
  pagesPerHost: number;
  latencyMs: number;
  linksPerPage?: number;
  crawlDelaySeconds?: number;
  rateLimitEvery?: number;
}

export interface FakeSiteNetwork {
  fetchImpl: typeof fetch;
  resolveDns: (host: string) => Promise<string[]>;
  seeds: string[];
  requests: () => number;
  peakPerHost: () => Map<string, number>;
  scope: (url: string) => boolean;
}

export function fakeSiteNetwork(clock: VirtualClock, options: FakeSiteOptions): FakeSiteNetwork {
  const hosts = Array.from(
    { length: options.hosts },
    (_, index) => `site${index + 1}.bench.example`,
  );
  const links = options.linksPerPage ?? 8;
  const active = new Map<string, number>();
  const peak = new Map<string, number>();
  const served = new Map<string, number>();
  let requests = 0;
  const body = (host: string, index: number) => {
    let seed = index + 1;
    for (let char = 0; char < host.length; char += 1)
      seed = (seed * 31 + host.charCodeAt(char)) % 2_147_483_648;
    const text = Array.from({ length: 80 }, () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return `term${seed % 500}`;
    }).join(" ");
    const anchors = Array.from({ length: links }, (_, offset) => {
      const target = (index * links + offset + 1) % options.pagesPerHost;
      return `<a href="https://${host}/docs/page-${target}">Guide ${target}</a>`;
    }).join(" ");
    return `<!doctype html><html lang="en"><head><title>${host} page ${index}</title></head><body><main><h1>Page ${index} of ${host}</h1><p>Page ${index} unique identifier ${host}-${index}. ${text}</p><p>${anchors}</p></main></body></html>`;
  };
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests += 1;
    const host = url.host;
    active.set(host, (active.get(host) ?? 0) + 1);
    peak.set(host, Math.max(peak.get(host) ?? 0, active.get(host) ?? 0));
    try {
      await clock.sleep(options.latencyMs);
      if (url.pathname === "/robots.txt") {
        const delay =
          options.crawlDelaySeconds === undefined
            ? ""
            : `Crawl-delay: ${options.crawlDelaySeconds}\n`;
        return new Response(`User-agent: *\n${delay}Allow: /\n`, {
          headers: { "content-type": "text/plain" },
        });
      }
      if (url.pathname === "/sitemap.xml" || url.pathname === "/sitemap_index.xml")
        return new Response("missing", { status: 404 });
      const count = (served.get(host) ?? 0) + 1;
      served.set(host, count);
      if (options.rateLimitEvery !== undefined && count % options.rateLimitEvery === 0)
        return new Response("slow down", { status: 429, headers: { "retry-after": "2" } });
      const match = /^\/(?:docs\/page-(\d+))?$/.exec(url.pathname);
      if (match === null) return new Response("missing", { status: 404 });
      return new Response(body(host, Number(match[1] ?? 0)), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    } finally {
      active.set(host, (active.get(host) ?? 1) - 1);
    }
  };
  return {
    fetchImpl,
    resolveDns: () => Promise.resolve(["93.184.215.14"]),
    seeds: hosts.map((host) => `https://${host}/`),
    requests: () => requests,
    peakPerHost: () => new Map(peak),
    scope: (url) => hosts.some((host) => url.startsWith(`https://${host}/`)),
  };
}

export interface BenchScenario {
  label: string;
  workers: number;
  perHost: number;
  minIntervalMs: number;
  site: FakeSiteOptions;
  maxPages: number;
}

export interface BenchResult {
  label: string;
  workers: number;
  perHost: number;
  pages: number;
  requests: number;
  virtualSeconds: number;
  pagesPerSecond: number;
  peakPerHost: number;
  stopReason: string;
  result: CrawlResult;
}

export async function runBenchScenario(scenario: BenchScenario): Promise<BenchResult> {
  const clock = new VirtualClock();
  const network = fakeSiteNetwork(clock, scenario.site);
  const now = () => new Date(clock.now());
  const politeness = new HostPoliteness({
    perHost: scenario.perHost,
    minIntervalMs: scenario.minIntervalMs,
    now: clock.now,
    sleep: clock.sleep,
  });
  const fetcher = createFetcher({
    fetchImpl: network.fetchImpl,
    resolveDns: network.resolveDns,
    now,
    sleep: clock.sleep,
    maxPages: scenario.maxPages * 4,
    hostGate: politeness,
  });
  const result = await clock.run(
    crawl({
      fetcher,
      seeds: network.seeds,
      scope: network.scope,
      profile: DOCS_PROFILE,
      concurrency: scenario.workers,
      now: clock.now,
      sleep: clock.sleep,
      budget: {
        maxPages: scenario.maxPages,
        maxDurationMs: 3_600_000,
        maxDepth: 50,
        maxPerPattern: 10_000,
        maxSitemapFetches: scenario.site.hosts * 2,
      },
      onPage: () => Promise.resolve(true),
    }),
  );
  const seconds = clock.now() / 1000;
  return {
    label: scenario.label,
    workers: scenario.workers,
    perHost: scenario.perHost,
    pages: result.pages.length,
    requests: network.requests(),
    virtualSeconds: Math.round(seconds * 10) / 10,
    pagesPerSecond: seconds === 0 ? 0 : Math.round((result.pages.length / seconds) * 10) / 10,
    peakPerHost: Math.max(0, ...network.peakPerHost().values()),
    stopReason: result.stopReason,
    result,
  };
}

export const BENCH_SITE: FakeSiteOptions = { hosts: 8, pagesPerHost: 60, latencyMs: 250 };

export function benchScenarios(): BenchScenario[] {
  const pages = BENCH_SITE.hosts * BENCH_SITE.pagesPerHost;
  return [
    {
      label: "legacy-equivalent (1 worker, 1 req/s per host)",
      workers: 1,
      perHost: 1,
      minIntervalMs: 1_000,
      site: BENCH_SITE,
      maxPages: pages,
    },
    ...[1, 4, 8, 16, 32, 48].map((workers) => ({
      label: `${workers} workers, 6 per host`,
      workers,
      perHost: 6,
      minIntervalMs: 100,
      site: BENCH_SITE,
      maxPages: pages,
    })),
    {
      label: "single host, 32 workers, 6 per host",
      workers: 32,
      perHost: 6,
      minIntervalMs: 100,
      site: { hosts: 1, pagesPerHost: 300, latencyMs: 250 },
      maxPages: 300,
    },
    {
      label: "slow single host (1.5 s latency), 32 workers, 6 per host",
      workers: 32,
      perHost: 6,
      minIntervalMs: 100,
      site: { hosts: 1, pagesPerHost: 120, latencyMs: 1_500 },
      maxPages: 120,
    },
  ];
}

export function formatBench(results: readonly BenchResult[]): string {
  const header = "| scenario | pages | requests | virtual s | pages/s | peak per host |";
  const rule = "|---|---|---|---|---|---|";
  const rows = results.map(
    (row) =>
      `| ${row.label} | ${row.pages} | ${row.requests} | ${row.virtualSeconds} | ${row.pagesPerSecond} | ${row.peakPerHost} |`,
  );
  return [header, rule, ...rows].join("\n");
}
