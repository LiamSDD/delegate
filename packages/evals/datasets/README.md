# Eval datasets

Golden cases for each mission, versioned with the code. Datasets arrive in M1 (Company X-ray first); this file fixes the format so the harness, the `eval-analyst` agent and reviewers agree on it.

## Layout

```text
datasets/
  <mission>/
    v<N>.jsonl        one EvalCase per line
    CHANGELOG.md      what changed between versions and why
```

- `<mission>` is the mission id (`xray`, `automation-audit`, ...).
- A dataset version is immutable once an eval baseline references it. Adding, removing or editing a case creates `v<N+1>.jsonl`; baselines compare like with like.
- At least 8 cases per mission (SPEC: real companies and repositories of different sizes, industries and languages).

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
