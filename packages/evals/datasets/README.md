# Eval datasets

Golden cases for each mission, versioned with the code. Datasets arrive in M1 (Company X-ray first); this file fixes the format so the harness, the `eval-analyst` agent and reviewers agree on it.

## Layout

```text
datasets/
  <mission>/
    v<N>.jsonl        one EvalCase per line
    CHANGELOG.md      what changed between versions and why
    human-labels.v1.jsonl   judge calibration labels written by `pnpm label`
```

- `<mission>` is the runtime mission id (`company-xray`, `automation-audit`, `build-agent`, `repo-xray`, `custom-goal`). Cases carry a `mission` literal checked by their schema: the CLI name for `xray`, `audit` and `build`, the runtime id for `repo-xray` and `custom-goal` (kept from their v1).
- A dataset version is immutable once an eval baseline references it. Adding, removing or editing a case creates `v<N+1>.jsonl`; baselines compare like with like.
- At least 8 cases per mission (SPEC: real companies and repositories of different sizes, industries and languages); a test enforces it for every mission the CLI runs.

## Missions

| `--mission` | Dataset | Cases | Deterministic hard checks | Judge prompt (criteria) |
|---|---|---|---|---|
| `xray` | `company-xray/v1.jsonl` | 8 | `run_completed`, `schema_valid`, `claims_cited`, `citations_resolve`, `quotes_in_sources` | `xray-judge.v1` (accuracy, specificity, actionability, citationFaithfulness) |
| `audit` | `automation-audit/v1.jsonl` | 8 | `run_completed`, `schema_valid`, `opportunity_count` (5-8), `citations_resolve` | `audit-judge.v1` (specificity, evidenceSupport, roiPlausibility, actionability) |
| `build` | `build-agent/v1.jsonl` | 8 | `run_completed`, `schema_valid` (assistant ready), `out_of_scope_refused`, `answers_cited`, `citations_on_site` | `build-judge.v1` (correctness, groundedness, refusalQuality, concision) |
| `repo` | `repo-xray/v2.jsonl` | 8 | `run_completed`, `schema_valid`, `citations_resolve`, `mermaid_nodes_real`, `improvements_valid` | `repo-judge.v1` (accuracy, specificity, actionability, onboardingClarity) |
| `goal` | `custom-goal/v2.jsonl` | 8 | `run_completed`, `plan_valid`, `schema_valid`, `claims_cited`, `action_plan_present` | `goal-judge.v1` (relevance, specificity, actionability, citationFaithfulness) |

Each mission is a `MissionAdapter` in `src/missions/`: it loads and validates its dataset, grades an event log, names its mission metrics, renders the view its judge sees and says when a trial is judgeable. Every mission also gets soft checks for latency, cost, token budget, repeated fetches and policy denials. Case schemas, case tables, verification notes and exclusions are in each dataset's `CHANGELOG.md`. Every expected fact, hint and answer records the date it was checked against the live source (`verifiedAt`).

- **Company X-ray** (`company-xray/`): `XrayCaseSchema` (`src/datasets/xray.ts`, `schema.v1.json`); 2 to 5 `expectedFacts` per company.
- **AI Automation Audit** (`automation-audit/`): `AuditCaseSchema` (`src/datasets/audit.ts`); 2 to 4 department and 2 to 4 workflow hints quoted from the company's site. Soft checks `departments_found` / `workflows_found` pass at 50% recall (`AUDIT_TARGETS`); a department hint matches an opportunity's department or title on its name or a synonym, a workflow hint matches its title, workflow or automation text on any term (normalised, case-insensitive substring). `no_generic_ideas` reuses the runtime's generic-idea patterns. `opportunity_count` stays a hard 5-8 check even when the deliverable says the evidence was insufficient: every case's hints are quoted from the company's own public pages, so the evidence for at least five workflows exists, and an audit that finds fewer has a research or verification gap to fix, not a pass to claim. Accepting a self-declared "insufficient evidence" flag as a pass would let a run grade itself. The flag is graded instead by the soft check `shortfall_flagged`: an audit with fewer than 5 opportunities must carry `shortfall` (found, minimum, reason) and say so in its summary, and an audit with 5 or more must not.
- **Build-an-Agent** (`build-agent/`): `BuildCaseSchema` (`src/datasets/build.ts`); 6 to 10 question/answer pairs whose `sourceUrl` must be on the crawled host, and exactly 3 out-of-scope questions. After the build completes the harness asks the built assistant every question through the runtime's `answerQuestion` with the trial's own in-memory stores, retrying capacity refusals twice, and stores the record as `<trial>.qa.json`. An answer is correct when it is not refused and contains every `mustInclude` string (normalised, case-insensitive); `answer_accuracy` is soft and passes at 60% (`BUILD_TARGETS`). Capacity refusals (`rate_limited`, `unavailable`) count as unavailable, not wrong. Question answering is not counted in the trial's tokens or latency.
- **Repo X-ray** (`repo-xray/`): `RepoXrayCaseSchema` (`src/datasets/repo-xray.ts`); kind-typed expected facts matched by `factFound`. The judge never sees code text.
- **Custom goal** (`custom-goal/`): `CustomGoalCaseSchema` (`src/datasets/custom-goal.ts`); expected target, minimum actions, workstream hints and how the target was verified.

## Human labels and judge calibration

`pnpm label --mission <m> [--run <id>] [--labeller <handle>] [--limit n]` walks the judged trials stored under `results/runs/<m>/` that the labeller has not labelled yet, newest run first. For each it prints the rubric from the mission's judge prompt and the same deliverable view the judge saw, never the judge's scores, and asks for a 1 to 5 score per criterion (`s` skips, `q` stops). Labels are appended to `datasets/<dataset>/human-labels.v1.jsonl`, one `HumanLabelSchema` object per line, validated against the mission's criteria; the same labeller cannot label a trial twice:

```json
{"caseId":"zed","run":"2026-11-24T10-00-00-000Z","trial":0,"labeller":"owner","labelledAt":"2026-11-25","scores":{"accuracy":4,"specificity":4,"actionability":3,"citationFaithfulness":5},"notes":"optional"}
```

Agreement (exact-match rate, within-one rate, Cohen's kappa with a 95% asymptotic interval, per criterion) is computed over every labelled trial whose `judge.json` is still on disk. `pnpm label` and `pnpm agreement [--mission m]` write it to `results/calibration/<m>.json`, which `/evals` shows; each eval run also records it in its result file. It is a CLI rather than a web page because the deliverables live in local, git-ignored run directories, the labels are committed dataset files and the deployed `/evals` page is static and read-only.

## Running

```bash
pnpm eval --mission xray|audit|build|repo|goal|all [--trials 3] [--cases id,id] [--tag gate] [--audience public-demo|owner] [--offline | --replay <run dir>] [--concurrency 1-8] [--no-judge] [--baseline]
pnpm eval:smoke          # one gate case per mission: scripted fixtures recorded, then replayed; part of pnpm check
pnpm gate                # pnpm check, then the X-ray gate-tagged cases x 1 trial; GATE_FULL=1 runs every case x 3
pnpm label --mission goal
pnpm agreement
```

Live runs load the repository-root `.env.local`. Raw runs go to `results/runs/<mission>/<timestamp>/` (`<case>/<trial>.events.jsonl`, `.trial.json`, `.judge.json`, `.qa.json` for Build-an-Agent, `summary.json`, `summary.md`) and are git-ignored; the result file `results/<mission>/<timestamp>.json` (`EvalResultFileSchema`, `src/results.ts`) is what gets committed and what `/evals` reads. Baselines are `results/baseline.json` (X-ray) and `results/baseline.<mission>.json`, written only with `--baseline`. A trial whose run fails with `no_model_available` is retried twice; the wait is 60 s then 120 s, or the largest `retryAfterMs` the run's fallbacks reported (at most 10 minutes), and it is shared, so concurrent workers pause too. The failed attempt's log is kept. Hard checks fail the gate; infrastructure failures (`no_model_available`, `site_unreachable`, `cancelled`) count as errored rather than invalid output. Judges use role `planner`, score 1 to 5 and are stored normalised as (score − 1) / 4.

## Case format

Each line is a JSON object validated by `EvalCaseSchema` (`src/types.ts`):

```json
{
  "id": "xray-001",
  "mission": "xray",
  "version": 1,
  "input": { "company": "example.com" },
  "checks": [
    { "kind": "schema_valid" },
    { "kind": "min_citations", "min": 5 },
    { "kind": "no_dead_links" },
    { "kind": "max_cost_micro_usd", "max": 0 },
    { "kind": "max_latency_ms", "max": 90000 }
  ],
  "rubric": ["Every claim about the company cites a source", "Recommendations are specific to the company"],
  "tags": ["saas", "small", "en"]
}
```

| Field | Meaning |
|---|---|
| `id` | Stable kebab-case id, unique within the mission. Never reused for a different case. |
| `input` | Exactly what a user would submit to the mission. |
| `checks` | Deterministic checks (schema, citations, dead links, budget, latency, required mentions). |
| `rubric` | Criteria for the LLM judge. Each criterion is scored 0 to 1; the judge prompt is versioned in `packages/runtime/prompts/`. |
| `tags` | Used for slicing results (size, industry, language). |

Money is always integer **micro-USD** (1 USD = 1,000,000), the same unit as `run_events` and the budget module. On the default keyless providers the expected cost is 0.

## Trials and results

- Every case runs at least 3 trials. A `Trial` (`TrialSchema`) records the prompt versions used (`{ "planner": 1, "critic": 2 }`), every serving `{ role, provider, model, calls }`, latency, cost, deterministic check results and judge scores.
- `summariseTrials` turns the trials of one case into a `Result` with mean score ± 95% CI (t-distribution) and a Wilson interval for the pass rate. Trials with different prompt versions are never mixed. Scores live in [0, 1], so the score interval is clamped to [0, 1]: `lower = max(0, mean − h)`, `upper = min(1, mean + h)` with `h = t(0.975, n−1) · s / √n`. With few trials near 0 or 1 the clamped side is conservative, not exact; the raw half-width is still `h`.
- `isRegression(baseline, candidate, threshold)` (`src/stats.ts`) is a one-sided Welch test of "the candidate is worse by more than the threshold", so noise on free providers does not block a merge and a real drop does:

  ```text
  worsening = mean(baseline) − mean(candidate)        (reversed when lower is better, e.g. cost)
  SE        = √(s²_baseline / n_baseline + s²_candidate / n_candidate)
  df        = Welch–Satterthwaite
  t         = (worsening − threshold) / SE
  p         = P(T_df ≥ t)
  regression ⇔ worsening > threshold and p < α        (α = 0.05 by default)
  ```

  `compareScores` returns `worsening`, `SE`, `t`, `df` and `p` so a verdict can be checked by hand. When both samples have zero variance, `p` is 0 if the worsening exceeds the threshold and 1 otherwise.

## Rules

- Never tailor runtime code or prompts to a case. If a case looks wrong, fix the case in a new dataset version and say why in the changelog.
- Cases use public information only. No personal data beyond what a company publishes about itself.
- Promoted production feedback (thumbs, corrections) becomes a new case in the next dataset version, with the source noted in `notes`.
