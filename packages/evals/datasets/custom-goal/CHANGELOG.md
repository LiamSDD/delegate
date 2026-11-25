# custom-goal dataset changelog

## v2 (2026-11-25)

The six v1 cases with `"version": 2`, plus two new cases (eight in total):

| Case                    | Area             | Company in the goal                    | Expected target                  |
| ----------------------- | ---------------- | -------------------------------------- | -------------------------------- |
| support-response-domain | customer support | typed domain                           | `basecamp.com`                   |
| hr-brand-only           | HR               | upper-case possessive brand, no domain | Wikidata-resolved brand (`IKEA`) |

- Every case whose expected target is a domain or a brand now carries `expected.verification` (`sourceUrl`, `verifiedAt`, `note`). `CustomGoalCaseSchema` accepts it as an optional field, and a test requires it on every domain or brand case. `CUSTOM_GOAL_DATASET` points at `v2.jsonl`; `v1.jsonl` stays loadable and unchanged. Topic-only cases (`engineering-no-company`, `vague-ai`) have no verification field.
- Both new goals parse as expected under `analyseGoal` (`basecamp.com` as the domain; brands `["IKEA"]` with no domain). `targetParseMatches` returns true for all eight cases, checked by `src/graders/custom-goal.test.ts`.
- Verification on 2026-11-25, one request each, all HTTP 200:
  - Domains, home page fetched: `https://www.hilti.com/` (canonical `https://www.hilti.com/`), `https://linear.app/`, `https://basecamp.com/`.
  - Brands, `Special:EntityData/Q….json` read for the official website (P856): Q1660552 Patagonia, Inc. (`https://www.patagonia.com`), Q483915 Nike (`https://www.nike.com/`), Q54078 IKEA (`https://www.ikea.com`). Patagonia's entity was found with one `wbsearchentities` request, which also returned the region (Q1507) that resolution must not pick.
- Wired into `pnpm eval --mission goal` (adapter `src/missions/goal.ts`, judge `prompts/goal-judge.v1.md`).
- Excluded: no new case uses a code host or a domain behind bot protection, so the home page check stays a plain GET.

## v1 (2026-11-25)

Six free-text goals covering the shapes the home input receives:

| Case | Area | Company in the goal | Expected target |
|---|---|---|---|
| marketing-brand-possessive | marketing | capitalised possessive brand | Wikidata-resolved brand |
| ops-invoice-domain | operations | typed domain | `hilti.com` |
| engineering-no-company | engineering | none | topic-only plan |
| sales-playbook-domain | sales | typed domain | `linear.app` |
| brand-only-lowercase | marketing + agents | lower-case possessive brand | Wikidata-resolved brand |
| vague-ai | vague | none | topic-only plan, short honest brief |

- `expected.target` is checked offline against the deterministic parser (`analyseGoal`) by a unit test, and against the final brief's `company` by the grader.
- Deterministic graders (`src/graders/custom-goal.ts`): `run_completed`, `plan_valid` (3–8 steps, only library steps, required steps present), `schema_valid`, `claims_cited` (every finding, action basis and risk cites a source listed in the brief), `action_plan_present` (at least `expected.minActions` owned, cited, ranked actions) and `target_resolved`. All but `target_resolved` are hard checks.
- `gate` tag: marketing-brand-possessive, engineering-no-company, brand-only-lowercase.
- Not yet wired into `pnpm eval` (the CLI runs `--mission xray` only); the graders take an event log, so wiring is a runner change.
