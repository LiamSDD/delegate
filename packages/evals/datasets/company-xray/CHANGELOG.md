# company-xray dataset changelog

## v1 (2026-11-24)

Eight real public organisations, chosen for spread of country, industry and size:

| Case | Company | Country | Industry | Size | Expected facts |
|---|---|---|---|---|---|
| atlassian | Atlassian | AU | collaboration SaaS (public) | large | 4 |
| adyen | Adyen | NL | payments fintech (public) | large | 4 |
| zed | Zed Industries | US | open-source developer tools | small | 4 |
| lego | The LEGO Group | DK | consumer toys (private) | large | 3 |
| hilti | Hilti Group | LI | B2B construction tools | large | 3 |
| rakuten | Rakuten Group | JP | internet conglomerate, English corporate site | large | 4 |
| cern | CERN | CH | intergovernmental public research | large | 4 |
| mistral-ai | Mistral AI | FR | AI startup | medium | 4 |

- Every expected fact was checked on 2026-11-24 against the cited page (company site or Wikipedia), after reading the site's robots.txt; one or two requests per site. Volatile figures (headcount, volumes, member counts, model names) are deliberately not expected facts.
- `gate` tag (cheap `pnpm gate`): atlassian, zed, hilti.
- Excluded: Supabase (used in development runs of the mission). The loader rejects excluded domains (`XRAY_EXCLUDED_DOMAINS`).
- Considered and dropped on 2026-11-24: Mercari (corporate site and robots.txt returned 503 maintenance), Patagonia (served a maintenance page for robots.txt), Cybozu (403 to a non-browser client), Allbirds (sold its shoe business in 2026, facts unstable).
