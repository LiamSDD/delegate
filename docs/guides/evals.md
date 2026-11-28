# How evals work

An eval answers one question: did a change make the missions better or worse? The scoreboard at https://trydelegate.app/evals shows the answer with error bars. This page explains how the numbers are produced and how to read them.

## From a case to a number

**Cases.** Each of five missions has a versioned dataset of eight golden cases: real companies and repositories of different sizes, industries and languages. A dataset version never changes once a baseline refers to it. A new or corrected case creates the next version.

**Trials.** A trial is one complete run of a mission on one case, recorded as an event log. The default is three trials per case, because the models are not deterministic. A trial records the prompt versions used and the model that served each role, so results from different configurations are never mixed.

**Grading.** Every trial is graded three ways.

| Grader | What it checks | Effect |
|---|---|---|
| Hard checks, in code | The run completed, the deliverable matches its schema, claims are cited, citations resolve, quotes appear in their sources. Each mission adds its own. | Any failure fails the gate. |
| Soft checks, in code | Latency, cost, token budget, repeated fetches, policy denials, and mission targets such as answer accuracy. | Reported, not gating. |
| Judge, a model | A rubric of four criteria per mission, each scored 1 to 5. | Stored between 0 and 1. |

A trial that fails because no model was available, or the site could not be reached, counts as errored, not as invalid output. It is retried after a wait.

**The judge is checked too.** `pnpm label` shows a person the same deliverable the judge saw, without the judge's scores, and records a human score for each criterion. The scoreboard then reports how often the judge and the person agree, with Cohen's kappa. A judge that disagrees with people is a broken instrument, and the page shows it.

## How to read the scoreboard

The page is built from the result files committed under `packages/evals/results/`. Nothing on it is sampled or filled in, and a mission without a recorded run says so.

### Scoreboard

One row per mission, from its latest result file.

| Column | Meaning |
|---|---|
| Pass rate (95% CI) | The share of trials that passed, with a Wilson interval and the number of trials. |
| Score (mean ± 95% CI) | The mean deterministic score with a t-interval, clamped to the range 0 to 1. |
| Judge (0-1) | The judge's mean score. |
| Citations verified | The share of citations the graders could verify against the stored sources. |
| Latency p50 | The median time for a trial. |

Read the interval before the number. The case study quotes a Company X-ray result of 81% with an interval of 57% to 93% from 16 trials. That is 13 passes out of 16. With so few trials the honest reading is "probably between 57% and 93%", and the interval narrows only as trials are added.

### Cost against quality

One point per result file: tokens and spend per trial against pass rate. The Pareto frontier marks the configurations that no other configuration beats on both cost and quality.

### Judge calibration

For each criterion: how many labelled trials there are, how often the judge matched the person exactly, how often it was within one point, and Cohen's kappa with its interval.

### Evolution

The lineage of prompt and playbook changes proposed by `pnpm evolve`. A candidate is promoted only when all four hold:

- its mean score beats the baseline with `p < 0.05` on a Welch test;
- no case regresses;
- it has no more hard-check failures than the baseline;
- the red-team suite still has a success rate of 0%.

Every attempt is recorded with both arms' scores, the per-case comparison and the reasons for the decision, whether it was promoted or not.

### Red team

The attack success rate by category. See [the red-team suite](red-team.md).

## What counts as a regression

Free model providers are noisy, so "the score went down" is not enough to block a change. The test is one-sided: a candidate is a regression when it is worse than the baseline by more than a threshold and a Welch test gives `p < 0.05`. The comparison returns the difference, its standard error, the statistic and the degrees of freedom, so a verdict can be checked by hand. [Datasets and statistics](../../packages/evals/datasets/README.md#trials-and-results) has the formulas.

## Run them

```bash
pnpm eval --mission xray      # xray, audit, build, repo, goal or all
pnpm eval:smoke               # one gate case per mission from scripted fixtures; part of pnpm check
pnpm gate                     # pnpm check, then the X-ray gate cases with one trial
pnpm label --mission goal     # label judged trials by hand
pnpm agreement                # recompute judge agreement
```

A live evaluation needs a model, takes minutes per mission and is a deliberate operator action. It never runs on a request path. Raw runs go to a git-ignored directory. The committed result file is what the scoreboard reads.

`pnpm eval:smoke` is different in kind: it replays scripted fixtures to prove that the harness, the graders and the result format still work. It says nothing about model quality.

## What the numbers do not say

- Samples are small. Eight cases and three trials give wide intervals, and the page shows them.
- A result belongs to the models that served it. The free chain changes, so the serving model is recorded on every trial.
- A passing hard check means the deliverable is well-formed and its citations hold. It does not mean the brief is insightful. That is what the judge and the human labels are for.
