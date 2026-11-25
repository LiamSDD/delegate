# custom-goal dataset changelog

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
