# automation-audit dataset changelog

## v1 (2026-11-25)

Eight real organisations, chosen for spread of country, industry and size:

| Case                 | Company                        | Country | Industry                                | Size   | Departments | Workflows |
| -------------------- | ------------------------------ | ------- | --------------------------------------- | ------ | ----------- | --------- |
| xero                 | Xero                           | NZ      | accounting SaaS (public)                | large  | 3           | 3         |
| vestas               | Vestas Wind Systems            | DK      | wind turbine manufacturer, English site | large  | 3           | 4         |
| marks-and-spencer    | Marks and Spencer              | GB      | retailer                                | large  | 3           | 4         |
| hiscox-uk            | Hiscox UK                      | GB      | insurance                               | large  | 2           | 3         |
| maersk               | A.P. Moller - Maersk           | DK      | container logistics, English site       | large  | 3           | 4         |
| companies-house      | Companies House                | GB      | public-sector registry (GOV.UK)         | medium | 4           | 4         |
| wikimedia-foundation | Wikimedia Foundation           | US      | nonprofit                               | medium | 4           | 3         |
| 37signals            | 37signals (input basecamp.com) | US      | project-management SaaS                 | small  | 3           | 3         |

- Every hint was checked on 2026-11-25 against the cited page, after reading the site's robots.txt once. All cited pages are allowed by robots.txt and served plain HTML to `curl` with the user agent `delegate-eval-verifier/1.0`. Requests per site, robots.txt included: basecamp.com 6, 37signals.com 2, xero.com 5, vestas.com 5, marksandspencer.com 4, hiscox.co.uk 4, maersk.com 3, gov.uk 3, wikimediafoundation.org 5.
- Every `sourceUrl` returned HTTP 200. Two are the targets of redirects from the URL requested: `/c/help` to `/help-and-support` (M&S) and `/about/` to `/who-we-are/` (Wikimedia Foundation).
- `evidence` is a paraphrase or a short quote of the cited page. Hints describe what the public site shows (help centres, claims pages, supplier pages, investor pages, handbooks, job-section headings); no internal process is assumed. Size is a coarse band, not a verified headcount.
- Matching: a department hint is found when any opportunity's `department` or `title`, lowercased, contains the hint's `name` or any synonym. A workflow hint is found when the lowercased `title`, `workflow` and `automation` text of any opportunity contains any of its `terms`.
- `department` input (focused audit): vestas (Procurement), hiscox-uk (Claims).
- `gate` tag (cheap `pnpm gate`): companies-house, wikimedia-foundation, 37signals.
- Excluded: Supabase (used in development runs of the mission).
- Considered and dropped on 2026-11-25: Royal Mail (robots.txt returned 403), Lush (robots.txt returned 403), PostNL (connection failed), Xero careers page (redirects to careers.xero.com, which returned 403 to a non-browser client; Xero kept, careers not cited), Hiscox `/claims` (404; the existing-customers page is cited instead), Basecamp `/support` (redirects to a separate help domain, not cited). Maersk careers pages are disallowed by robots.txt and were not fetched.
