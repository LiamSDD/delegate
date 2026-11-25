import { lookup } from "node:dns/promises";
import { parseArgs } from "node:util";

import { createFetcher } from "../tools/fetch";
import { createPinnedFetch, RESEARCH_MAX_RESPONSE_BYTES } from "../tools/node-fetch";
import { siteScope } from "../tools/research";
import { benchScenarios, formatBench, runBenchScenario } from "./bench";
import { crawl, formatProgress } from "./engine";
import { HostPoliteness } from "./politeness";
import { COMPANY_PROFILE, DOCS_PROFILE } from "./priority";

const SAFE_PER_HOST = 4;

async function resolveDns(host: string): Promise<string[]> {
  const answers = await lookup(host, { all: true, order: "verbatim" });
  return answers.map((answer) => answer.address);
}

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function fake(): Promise<void> {
  const results = [];
  for (const scenario of benchScenarios()) results.push(await runBenchScenario(scenario));
  write(
    "Fake network: 250 ms latency per request, 100 ms minimum interval per host, virtual clock.\n",
  );
  write(formatBench(results));
}

async function real(
  url: string,
  values: {
    pages: number;
    workers: number;
    perHost: number;
    seconds: number;
    profile: string;
    verbose: boolean;
  },
): Promise<void> {
  const perHost = Math.min(values.perHost, SAFE_PER_HOST);
  const politeness = new HostPoliteness({ perHost });
  const fetcher = createFetcher({
    fetchImpl: createPinnedFetch(resolveDns, { maxResponseBytes: RESEARCH_MAX_RESPONSE_BYTES }),
    resolveDns,
    maxPages: values.pages * 4,
    hostGate: politeness,
  });
  const scope = siteScope(url);
  const started = Date.now();
  const result = await crawl({
    fetcher,
    seeds: [url],
    scope: (candidate) => scope.contains(candidate),
    profile: values.profile === "company" ? COMPANY_PROFILE : DOCS_PROFILE,
    concurrency: values.workers,
    budget: { maxPages: values.pages, maxDurationMs: values.seconds * 1000 },
    onPage: () => Promise.resolve(true),
    progressEveryMs: 5_000,
    onProgress: (progress) => {
      write(formatProgress(progress));
    },
  });
  const seconds = (Date.now() - started) / 1000;
  write("");
  write(`URL            ${url}`);
  write(
    `Settings       ${values.workers} workers, ${perHost} per host, ${values.pages} page budget, ${values.seconds} s budget`,
  );
  write(
    `Pages kept     ${result.pages.length} in ${seconds.toFixed(1)} s (${(result.pages.length / Math.max(seconds, 0.001)).toFixed(1)} pages/s)`,
  );
  write(
    `Fetched        ${result.stats.fetched} pages, ${Math.round(result.stats.bytes / 1024)} KB, ${result.stats.sitemapsFetched} sitemaps (${result.stats.sitemapUrls} URLs)`,
  );
  write(`Stop reason    ${result.stopReason}`);
  write(`Skipped        ${JSON.stringify(result.stats.skippedByCode)}`);
  if (values.verbose)
    for (const skip of result.skipped.filter((entry) => entry.code !== "scope").slice(0, 40))
      write(`  ${skip.code.padEnd(16)} ${skip.url} (${skip.reason})`);
  for (const host of result.hosts)
    write(
      `Host           ${host.host}: ${host.requests} requests, ${host.requestsPerSecond} req/s, peak ${host.peakActive}/${host.maxConcurrent}, ${host.avgLatencyMs} ms avg, ${host.rateLimited} rate-limited${host.crawlDelayMs === undefined ? "" : `, crawl-delay ${host.crawlDelayMs} ms`}`,
    );
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      fake: { type: "boolean", default: false },
      pages: { type: "string", default: "60" },
      workers: { type: "string", default: "32" },
      "per-host": { type: "string", default: "4" },
      seconds: { type: "string", default: "60" },
      profile: { type: "string", default: "docs" },
      verbose: { type: "boolean", default: false },
    },
  });
  const url = positionals[0];
  if (values.fake || url === undefined) {
    await fake();
    if (url === undefined)
      write(
        "\nPass a URL to measure a real site: pnpm --filter @delegate/runtime crawl-bench https://docs.example.com/",
      );
    return;
  }
  await real(url, {
    pages: Number(values.pages),
    workers: Number(values.workers),
    perHost: Number(values["per-host"]),
    seconds: Number(values.seconds),
    profile: values.profile,
    verbose: values.verbose,
  });
}

await main();
