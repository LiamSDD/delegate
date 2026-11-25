# build-agent dataset changelog

## v1 (2026-11-25)

Eight real public sites, chosen for spread of kind, country and size. Each case gives the mission a site URL and a goal; the built assistant is then asked questions whose answers are stated on the site, plus three out-of-scope questions it must decline.

| Case                 | Site                       | Kind                            | Questions | Out of scope |
| -------------------- | -------------------------- | ------------------------------- | --------- | ------------ |
| letsencrypt          | Let's Encrypt (US)         | nonprofit certificate authority | 9         | 3            |
| sqlite               | SQLite (US)                | open-source library             | 8         | 3            |
| curl                 | curl (SE)                  | open-source tool                | 8         | 3            |
| plausible            | Plausible Analytics (EE)   | SaaS analytics                  | 7         | 3            |
| mullvad              | Mullvad VPN (SE)           | consumer VPN service            | 8         | 3            |
| prusa                | Prusa Research (CZ)        | 3D printer manufacturer         | 7         | 3            |
| rijksmuseum          | Rijksmuseum (NL)           | national museum                 | 7         | 3            |
| national-archives-uk | The National Archives (GB) | public body                     | 7         | 3            |

Totals: 61 questions, 24 out-of-scope questions.

### Verification

- Every question was checked on 2026-11-25 against the live page named in its `sourceUrl`; each answer is stated explicitly on that page. `verifiedAt` records the date.
- For each site, `/robots.txt` was read first and respected; then one request per page, two to three pages per site (at most four requests per site including robots.txt). The National Archives sets `Crawl-delay: 10`, which was honoured between requests. Client: curl with user agent `delegate-eval-verifier/1.0`.
- Every `sourceUrl` returned HTTP 200 and sits on the same host as `input.url` (and under it, where `input.url` has a path), so a same-domain crawler can reach it. `https://www.nationalarchives.gov.uk/about/` redirects to `/about-us/`; the dataset cites the final URL.
- Volatile facts (prices, customer and record counts, headcount, release versions, partner lists) are deliberately not asked.

### `mustInclude` matching

Each question lists one to three strings. A correct answer must contain all of them, after normalising both strings (Unicode NFKC, curly apostrophes to straight, whitespace collapsed) and comparing case-insensitively as substrings. Strings were chosen to survive rephrasing (for example `90` rather than `90 days`, `subscri` to match subscribers or subscriptions) and each one appears both in the expected answer and on the cited page.

### Out of scope

Exactly three per site, varied across sites: one topically adjacent but unanswerable from the site (for example GA4 conversion tracking for Plausible, a Creality printer for Prusa, a pizza restaurant in Gothenburg for Mullvad), plus unrelated general knowledge, live data or creative requests.

### Gate cases

`gate` tag (cheap `pnpm gate`): sqlite, curl. Both are small, static, plain-HTML sites with permissive robots.txt.

### Known risks

- national-archives-uk: `Crawl-delay: 10` limits a polite crawler to roughly 30 pages within the 300 s latency budget. The answer pages are within two clicks of the home page. Tagged `crawl-delay`.
- letsencrypt: the FAQ states a 90-day default lifetime today; Let's Encrypt has announced shorter lifetimes, so re-verify this question at the next version.
- rijksmuseum: opening hours (9am to 5pm) are stated on the visit page but could change; `input.url` is the English subpath `/en` so the crawler starts in English.

### Considered and dropped (2026-11-25)

- Raspberry Pi (`www.raspberrypi.com`): `/about/` returned 403 to a non-browser client.
- Framework (`frame.work`): robots.txt returned a 302 redirect; not pursued.
- Fairphone (`www.fairphone.com`): about page is marketing copy with few stated facts and geo-redirects visitors; help lives on a separate support host.
- Arduino (`www.arduino.cc`): about page has few stable facts (mainly partner lists and biographies), and ownership changed recently.
- Keychron and Pimoroni: robots.txt read only; Shopify storefronts with support content not clearly on the same host. Not pursued.
- Supabase: excluded (used in development runs of the missions).
