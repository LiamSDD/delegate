# ADR 0004: Keyless research sources and a hardened fetch tool

- Status: Accepted
- Date: 2026-11-24

## Context

The original spec uses Anthropic's server-side `web_search` and `web_fetch`. Under the $0, keyless rule (ADR 0003) neither is available, and scraping search engines breaks their terms. Company X-ray still needs cited facts about offering, customers, market, competitors, positioning, news and tech stack.

Probe results on 2026-11-24: Pollinations' keyless `openai` model (gpt-oss-20b) supports tool calling and streaming, reports usage including cached tokens, and served 6 sequential requests without throttling. LLM7's anonymous tier no longer serves tool-capable open models (401 / allowance exhausted / "does not support tools"), and its catalogue resells proprietary models, so it is removed from the default chains.

## Decision

Research uses only sources that need no key and allow automated access:

1. **The company's own site**, crawled politely: `robots.txt` honoured, same registrable domain only, sitemap first, then likely pages (about, pricing, customers, product, blog/news, careers), at most 25 pages and 1 request per second per host.
2. **Wikipedia and Wikidata** REST APIs (descriptive User-Agent), for founding facts, industry and listed competitors.
3. **GitHub public API** (unauthenticated, 60 requests/hour) for open-source and tech-stack signals when the company has an org.
4. **RSS/Atom feeds** linked from the site, for recent news.

All fetching goes through one `fetchPage` tool:

- DNS resolution with every resolved address checked against private, loopback, link-local, CGNAT, multicast and metadata ranges (IPv4 and IPv6); re-checked on every redirect (max 5); https or http only; no credentials in URLs.
- Size cap 2 MB, time cap 15 s, content types limited to HTML, text, XML and JSON.
- HTML converted to clean text with structural hints (headings, links) before anything else sees it.
- Every fetched document is stored as a `document` row (classification `public`) and becomes a citable source id.

Fetched text is never shown to a privileged agent: it goes through the quarantined reader (ADR 0002), which returns typed facts with quoted spans and an `injectionSuspected` flag.

Claims without a source are not allowed in the deliverable schema. Where the keyless sources cannot support a section (for example, five named competitors for a small private company), the brief says so instead of guessing.

## Consequences

- No coverage of third-party news beyond the company's own feeds and Wikipedia; the brief labels its source mix so readers can judge coverage.
- Slower than a search API (crawl + quarantine per page); the 90-second target constrains the page budget.
- The fetch tool's SSRF protections are a security boundary and get their own test matrix (DNS rebinding, IPv6-mapped addresses, decimal/hex IPs, redirects into private space).
- If an owner later adds a free search key, it plugs in as another research tool behind the same policy checks.
