# ADR 0012: One crawl engine, parallel across hosts and polite per host

- Status: Accepted
- Date: 2026-11-25
- Amends: ADR 0004 ("at most 25 pages and 1 request per second per host"); ADR 0007 (crawl resume)

## Context

Three missions fetched the company's site in three ways. Company X-ray and the Automation Audit picked up to 15 URLs by name from the homepage and one sitemap, then fetched them in one burst. Build it walked the site one page at a time. Every path ran through the hardened fetcher, which spaced requests to a host one second apart. A 60-page Build it crawl took more than a minute; a 300-page one could not fit a serverless function. The owner asked for 20 to 50 concurrent workers.

Text quality was the other limit. `htmlToText` kept every navigation menu, cookie banner and footer, so the quarantined reader and the chunker spent tokens on boilerplate, and near-identical template pages reached the reader as separate sources. Structured data (JSON-LD, OpenGraph) that states an organisation's address or a product's price was thrown away with the `<script>` tags.

Production is Vercel serverless: 300 s per function invocation and about 2 GB of memory. A crawl has to fit one step's budget or resume after the cut.

## Decision

`packages/runtime/src/crawl/` is the one crawl engine. Company X-ray, the Automation Audit (both through the research kit's `crawl_site` tool), Build it and the `crawl-bench` script call `crawl()`.

### Throughput from parallelism across URLs and hosts, never from one site

- **Worker pool.** 32 workers by default, configurable and clamped to 1 to 64; the owner's range of 20 to 50 is the intended setting. A worker takes the best-scoring URL from any host that has a free slot.
- **Per-host politeness (`HostPoliteness`).** Each host gets at most 6 requests in flight and at least 100 ms between request starts, so a single site never sees more than 10 requests per second. robots.txt `Crawl-delay` drops the host to one request at a time with that delay between starts, with no upper cap. A 429 or 503 backs the host off for its `Retry-After` (seconds or HTTP date, honoured in full), or 2 s doubling to 60 s without one, and halves the host's concurrency. If the latency average climbs past four times the host's best latency (and at least 1.5 s), or more than a quarter of recent requests fail, concurrency halves again. After twice its current limit in healthy responses in a row, the host climbs back by one, up to 6. A host whose backoff outlasts the time budget is left for the next run.
- **The gate lives in the fetcher.** `createFetcher({ hostGate })` acquires the host's slot after the URL, DNS, SSRF and robots checks and before the request, on every hop: robots.txt fetches and each redirect target included. The engine never calls the network itself. Every request still goes through `createFetcher` (and, in missions, through `executeToolCall` and the policy engine), so the SSRF, egress, DNS-per-hop and robots guards cannot be bypassed by the crawler. Slots are reserved when a request asks for one, rather than by re-reading the clock in a loop, so a frozen or virtual clock cannot stall the gate.
- **The interval caps the rate, the concurrency caps slow sites.** At 250 ms latency the 100 ms interval allows at most 3 requests in flight on one host; at 1.5 s latency the 6-request cap binds. One site is crawled at up to 10 pages per second. Many hosts (research across the site, its docs subdomain, Wikipedia and GitHub) run in parallel up to the worker count.

### Depth and quality

- **Discovery.** robots.txt `Sitemap:` lines, `/sitemap.xml` and `/sitemap_index.xml`, nested sitemap indexes read newest `lastmod` first (8 sitemap fetches and 5,000 URLs by default, 12 for Build it), RSS and Atom feeds linked from pages (company and audit profiles), `<link rel=sitemap>` hints and in-page links.
- **Normalisation and dedupe.** Fragments, tracking and session parameters (`utm_*`, `gclid`, `fbclid`, `jsessionid` and similar) are removed and the query is sorted. The dedupe key ignores `www.`, scheme, path case, trailing slashes and `index.html`. A redirect target or a `rel=canonical` already crawled counts as a duplicate. Main text is hashed (SHA-256 over normalised words) for exact copies and simhashed (64-bit, 2-word shingles, Hamming distance 6 or less, found through eight 8-bit bands) for near-copies of pages with at least 300 characters of main text.
- **Skipped before fetching.** Assets and binaries, auth, account, cart, checkout, admin, search, feed, tag, author and print paths, action and search parameters (`add-to-cart`, `replytocom`, `s`, `q`, `sort`, `filter` and more), more than three query parameters, URLs over 300 characters, other locales than the start page's (English always allowed), and `noindex` pages (`nofollow` pages contribute no links).
- **Trap guards.** Calendar-like URLs (date paths under calendar segments, `month`, `date`, `ical` and similar parameters) are capped at 3 per URL pattern. Pagination past page 5 is dropped. Paths with a segment repeated more than twice, a repeated multi-segment tail or more than 8 segments are dropped. Any URL pattern (digits normalised) is capped at 25 by default and 60 for Build it. Each page contributes at most 150 links (200 for Build it), main-content links first. Depth is capped at 4 (6 for Build it), the frontier at 2,000 URLs (3,000), and the number of fetch attempts at three times the page budget.
- **Priority queue.** A binary heap per host, scored by mission profile: topic terms in the path or the anchor text, minus depth and path length, minus a locale penalty and a query penalty, plus a bonus for sitemap entries, recent `lastmod` and main-content links. Ties go to the shallower URL and then to the first seen, which keeps the crawl breadth-first. `COMPANY_PROFILE` ranks about, pricing, product, customers, comparisons, security, careers, integrations, news, docs, contact and legal; `AUDIT_PROFILE` puts product, support, pricing and careers first; `DOCS_PROFILE` (Build it) puts docs, help, FAQ and guides first.
- **Extraction (`extractPage`).** A tolerant DOM tree drops hidden elements, `nav`, `footer`, `aside`, forms and dialogs, ARIA landmark roles for navigation and banners, and blocks whose class or id names a menu, footer, sidebar, cookie or consent banner, newsletter, share bar or similar, unless they contain the main content. The content root is `<main>` or `role=main`, else a single `<article>`, else the densest block by text length, link density and paragraph count, else the cleaned body. Output keeps `#` headings, nested `-` lists and pipe tables with a header rule, which the chunker already splits on. JSON-LD (Organization, Product, Offer, PostalAddress and kin) and OpenGraph or product meta are validated with zod and appended as a short "Structured data published by the page" list, so the quarantined reader can quote them; a structured line that trips the injection detector moves to `hiddenText` instead. Language comes from stopword counts for seven languages, falling back to `<html lang>`; pages in a language other than the first page's (or English) are skipped.
- **Jina Reader is not used.** ADR 0004 does not list it as an allowed source, so the engine has no fallback to it.

### Budgets per mission

| Mission | Profile | Pages crawled | Pages read by the reader | Time | Other |
|---|---|---|---|---|---|
| Company X-ray | company | 60 | 8 (homepage, best page per topic, then highest score) | 20 s | fetch cap 100 per run |
| Automation Audit | audit | 60 | 12 | 20 s | fetch cap 100 per run |
| Custom goal (site-crawl step, through the research kit) | company | 40 | 6 | 15 s | fetch cap 100 per run |
| Build it | docs | 300 | all (chunked and indexed) | 120 s | 60 MB, depth 6, checkpoint every 60 pages, fetch cap 340 per run |

X-ray and the Audit read only the top pages because every read is a quarantined model call. Crawling 60 pages lets the selection see the whole site instead of guessing from link names, and the unread pages become the gap filler's candidates, which `fetch_page` serves from memory without a second request.

### Progress and resume (ADR 0007)

- No new `RunEvent` type. Progress is an `agent.message` every 2 to 4 s ("Crawling: 48 pages kept, 61 fetched, 112 queued, 9 skipped, 2.1 MB in 6.2 s; acme.com 9.8 req/s (3/6 in flight)"), which the run page already shows in the agent's lane.
- Build it publishes a `crawl-state` artifact (`CrawlStateArtifactSchema`) every 60 stored pages and at the end: counters, per-host rate, concurrency, latency and backoff, and the checkpoint (stored pages, done keys, the frontier's best 400 entries including in-flight ones, the dedupe index, trap counters, sitemaps fetched). If the function is cut at 300 s, the resumed crawl step reads the latest `crawl-state` artifact from the log, restores the frontier and indexes, skips discovery, rebuilds the report from the stored documents and never refetches a stored page. A crash before the first checkpoint still reuses stored documents through the knowledge store, as before.
- When the time budget ends a crawl, in-flight requests are aborted and their URLs go back on the frontier, so the checkpoint loses nothing.

## Measurements

Deterministic benchmark (`src/crawl/bench.ts`, virtual clock, fake network with 250 ms latency, 8 hosts with 60 pages each; `pnpm --filter @delegate/runtime crawl-bench --fake`):

| Scenario | Pages per second | Peak in flight per host |
|---|---|---|
| Legacy-equivalent (1 worker, 1 request per second per host) | 1.0 | 1 |
| 4 workers | 15.0 | 3 |
| 16 workers | 38.7 | 3 |
| 32 workers | 61.9 | 3 |
| 48 workers | 63.6 | 3 |
| One host, 32 workers | 9.8 | 3 |
| One host at 1.5 s latency, 32 workers | 3.6 | 6 |

`bench.test.ts` checks that throughput scales with workers, that no host ever sees more than its limit, that Crawl-delay forces one request at a time, and that 429 with `Retry-After` backs off and still finishes.

Real site, one polite run on 2026-11-25 (`crawl-bench https://docs.python.org/3/ --pages 150 --per-host 4`): 150 pages kept in 15.5 s (9.7 pages per second), 152 requests, peak 3 in flight, no errors and no rate limiting. The old fetcher's one-second spacing needed more than 150 s for the same pages.

## Consequences

- One site sees up to 10 requests per second instead of 1. That is still polite by common crawler practice, and Crawl-delay, 429/503 and latency all slow it down automatically.
- Crawl-state artifacts add roughly 150 to 250 KB to the event log per checkpoint for a 300-page crawl (about 1 MB per run). Acceptable at current scale; a later change can store the checkpoint as a blob and keep only a pointer in the log.
- Main-content extraction drops footers, so a company's address now reaches the reader only when the page states it in the main content or in JSON-LD.
- Sitemaps served as `.xml.gz` files are not read: the fetcher allows only text content types. Most sites also serve plain `sitemap.xml`.
- The red-team suite gains a `crawl` target and 13 cases (dataset v2, `CHANGELOG.md`).
