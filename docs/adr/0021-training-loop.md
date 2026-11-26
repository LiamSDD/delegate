# ADR 0021: The training loop — measured prompt, playbook and routing improvements for every mission

- Status: Accepted
- Date: 2026-11-25
- Builds on: ADR 0003 (zero-cost model routing), ADR 0013 (evolving playbooks), ADR 0020 (learned routing, runtime side)

## Context

ADR 0013 introduced eval-gated evolution, but only for Company X-ray, one revision per invocation, with no memory between invocations. Since then every mission has a dataset, an adapter and committed result files, and three gaps remain:

1. **The gate and `pnpm evolve` drive one mission.** `src/gate.ts` evaluates `missions[0]` even when `--mission all` is given, and the evolve command refuses anything but `xray`. It also revises the shared `planner` prompt on X-ray evidence alone, although seven missions load that prompt and X-ray's result files do not even record its version.
2. **Nothing loops.** Improving a mission means running baseline and candidate arms by hand, remembering which arm was already paid for, and stopping before the free model chain's quota or the operator's patience runs out.
3. **Routing order is a hand-written list.** `config/models.json` ranks models from one bake-off. The eval harness records which models served a result file, but only in aggregate, so nothing can say which model is better for which mission and role.

Fine-tuning is impossible at $0 (ADR 0003), so "training" stays what ADR 0013 said it is: propose a change, measure it, keep it only when the evidence supports it. This ADR turns that into a loop that covers every mission and adds the third lever, learned routing.

## Decision

### 1. One table of training targets per mission (`packages/evals/src/evolve/targets.ts`)

`MISSION_TARGETS` is a pure table (no file access, so the web app can import it) with one row per eval mission:

| Mission | Hard checks (gate) | Prompts a candidate may change | House playbook keys |
|---|---|---|---|
| `xray` | `run_completed`, `schema_valid`, `claims_cited`, `citations_resolve`, `quotes_in_sources` | `synthesis` | `company-xray` |
| `audit` | `run_completed`, `schema_valid`, `opportunity_count`, `citations_resolve` | `analyst`, `auditEditor` | `automation-audit` |
| `build` | `run_completed`, `schema_valid`, `out_of_scope_refused`, `answers_cited`, `citations_on_site` | `designer` | `build-agent:<category>` (its inputs carry a goal) |
| `repo` | `run_completed`, `schema_valid`, `citations_resolve`, `mermaid_nodes_real`, `improvements_valid` | `repoArchitect`, `repoImprover` | `repo-xray` |
| `goal` | `run_completed`, `plan_valid`, `schema_valid`, `claims_cited`, `action_plan_present` | `goalSynthesis` | `custom-goal:<category>`, one per goal category |

- **Prompt targets are the mission's own generation prompts.** A target must be in the adapter's `runtimePrompts`, so the result files record its version and a baseline can be matched on it. Shared prompts (`planner`, `researcher`, `reader`, `critic`, `editor`) are not targets: a change to one would ship to every mission that loads it, so it would need a win on each of them, and the reader, critic and graders are the verifiers a candidate must not be able to weaken. Build-an-Agent's `answer` prompt is excluded because the harness asks the built assistant through a path that takes no prompt override; an arm would silently not test the change. This replaces ADR 0013's planner-on-X-ray target.
- **Playbook keys come from the runtime's own `playbookKey(missionId, input)`** applied to the dataset cases, so the goal and build missions train one house playbook per goal category that their cases cover, and the file a promotion writes is the file the runtime reads (`housePlaybookFileName(key)`, section 4). A test derives the keys from every dataset and checks them against the table.
- **Gate rules are per mission.** `missionGateVerdict` names the failing hard checks of that mission (from the summary's check pass rates), applies the mission's regression threshold to the baseline comparison in `results/baseline.json` (X-ray) or `results/baseline.<mission>.json`, and fails when every trial errored. `pnpm gate` now runs every selected mission (default `all`) and exits non-zero if any fails. All thresholds are 0.05 today; there is no evidence yet for mission-specific values, and the table is where one would go.

`pnpm evolve` takes `--mission` for all five, `--target <prompt key>` and `--key <playbook key>`, and uses a new proposer prompt (`evolve.proposer.v2.md`; v1 stays as shipped).

### 2. `pnpm train`: rounds of paired, gated comparisons

`pnpm train [--mission all|xray|audit|build|repo|goal] [--rounds N] [--budget-minutes M] [--trials T] [--dry-run]`

A round has two steps per mission, a **prompt step** and a **playbook step**. A step is: propose one candidate, evaluate it, decide, record. Rounds go round-robin over the missions, so a short budget spreads over all of them.

**Arms.** An arm is one eval of one configuration: mission, dataset version, case ids, trials per case, the version and content hash of every prompt the adapter loads, the house playbook per key, and the audience. That tuple is hashed into a fingerprint. A finished arm is written to `results/training/arms/<mission>/<fingerprint>.json` with its per-trial rows, tokens, wall time and serving, and an arm whose file exists is never run again. Two consequences fall out of the fingerprint: a promoted candidate's arm *is* the next step's baseline, and a rejected candidate leaves the baseline arm reusable for the next proposal.

**Baseline.** The parent configuration is the head of the training lineage: for each prompt target the latest promoted version (from the round records, if its file exists and is newer than the live pointer), otherwise the live version; for each playbook key the shipped house file. The baseline arm is, in order: the cached arm with that fingerprint; the latest result file under `results/<mission>/` when the configuration is exactly what `pnpm eval` measures (live prompt versions, no house playbook) and the file is a live run on the same dataset version with the same prompt versions, covers every selected case with at least T trials and records hard failures per trial; otherwise a fresh arm. Arms that training runs keep their raw logs under `results/training/runs/` (git-ignored) and never write into `results/<mission>/`, so the scoreboard and the routing evidence only ever show what `pnpm eval` measured.

**Candidates.** The `planner` role proposes (it never sees page text: the input is the target prompt body, aggregate eval numbers, check pass rates, failure codes and code-written playbook entries). A prompt proposal is a rationale plus at most eight bullet lines appended as a "Learned rules" section to one target prompt; URLs, personal data and injection-shaped text fail validation, with one repair attempt. A playbook proposal names one key and the entry ids to keep; it cannot write entry text. The entry pool is rebuilt deterministically from the baseline arm's event logs with the grader score of each trial (`rebuildPlaybook`), so it needs no model and is the same on every machine that has the logs; without logs there is no pool and the playbook step is recorded as rejected with that reason. The prompt step runs first; when it promotes, the playbook step compares against the new head, so the combination that would ship is always the one measured.

**Decision.** Baseline and candidate run the same cases with the same number of trials. Trials that errored on infrastructure are dropped from both arms. A candidate is promoted only when all of these hold:

1. The evolve gate (`decideEvolution`, which uses `compareScores`): the candidate's pooled mean beats the baseline's under a one-sided Welch test.
2. The paired view: the mean of the per-case differences (candidate case mean minus baseline case mean) is above zero under a one-sided t-test over cases, when at least two cases are paired. The record carries the difference with its 95% interval.
3. No case regresses: `isRegression` per case at the mission threshold, plus the plain rule that a case passing every baseline trial must not fail every candidate trial.
4. No new hard failure: no more hard-failing trials than the baseline, and no hard check failing on a case where it did not fail in the baseline.
5. The red-team suite reports 0% (run once per invocation; it does not depend on the candidate, whose text was already screened at proposal time).
6. The arms are comparable: for every role both arms used, the model that served most calls is the same. A candidate that wins because a stronger model happened to serve it is not promoted.

The significance level for 1 and 2 is 0.05 divided by the number of candidates already compared against the same baseline arm (Bonferroni), because a baseline that is reused for many proposals would otherwise promote noise sooner or later. Regression checks keep the unadjusted 0.05. The pooled Welch test counts between-case variance that the pairing cancels, so it is the conservative of the two; requiring both keeps the existing gate's guarantee and adds the test that matches the design.

An arm in which more than a quarter of the trials errored, or where a case has fewer than two graded trials, makes the step **inconclusive**: nothing is promoted, the arm is not cached as finished, and the mission is skipped for the rest of the invocation instead of burning the budget on a degraded chain.

**Promotion.** A promoted prompt is written as the next `<name>.v<N+1>.md` under `packages/runtime/prompts/`; no shipped file is edited, and pointing `RUNTIME_PROMPT_FILES` at it remains a reviewed one-line commit (ADR 0013). A promoted playbook is written as the next version of `packages/runtime/playbooks/<key>.house.json`. The training lineage continues from the promoted version at once, whatever the live pointer says.

**Records.** Every step writes `results/training/<id>.json` (`TrainingRecordSchema`): mission, round, kind, parent and child versions, both arms (source: run, cached or result file; score mean and interval, pass rate with Wilson interval, hard failures, errored, tokens, wall time, models), the Welch and paired comparisons, per-case rows, the adjusted significance level, the red-team result, the decision with its reasons, the promoted file, and the proposer model.

**Resuming, budget, cooldown.** The invocation's arguments hash into a session file under `results/training/pending/` (git-ignored) that records finished steps and accepted proposals, so running the same command again continues where it stopped and re-evaluates nothing: finished steps are skipped, a step in flight reuses its stored proposal, and its finished arms come from the arm files. The time budget (default 60 minutes) is checked between arms only. Before an arm starts, its duration is estimated from the mission's observed wall time per trial (arm files and result files; the adapter's latency target when there is no history) with a 25% margin, and an arm that would not finish inside the budget, counting any cooldown still pending, is not started. All arms and the proposer share one rate-limit cooldown (`SharedCooldown`, an additive option of the eval runner): a `no_model_available` retry wait in one arm also delays the next arm. `--dry-run` prints the plan, the arms that would run and their estimates, and writes nothing.

### 3. `pnpm route:learn`: which model serves each role best

**Evidence.** New result files record, per trial, which models served which role (`serving`, an optional field of the trial row) and its hard failures (`hardFailures`). `route:learn` reads the live result files under `results/<mission>/` (replays re-grade trials that were already counted, so they are skipped; training arms are skipped because candidate prompts are a confound). A trial is attributed to the model that served more than half of that role's calls in it; a trial with no such model is "mixed" and not attributed. A historical file without per-trial serving contributes only when its aggregate shows a single model for the role, in which case every non-errored trial is attributed to it; otherwise its trials are counted as unattributable and the reason says how many. Errored trials are infrastructure and are not counted. Per mission, role and model the command reports trials, pass rate with a Wilson 95% interval and the median trial latency. That latency is the whole trial's, not the model call's; it is context, not a ranking criterion.

**Decision rule.** Only models that `config/models.json` lists for the role are ranked, by pass rate, and only those with at least `minTrials` attributed trials (default 20, `--min-trials`). At least two such models are needed, otherwise there is nothing to separate. Going down the ranking, a model is added to the `learned` order when (a) its interval's lower bound is above the upper bound of every ranked model below it, and (b) every model configured ahead of it for that role is either already listed or has enough trials itself (in which case (a) has compared them). Listing stops at the first model that fails, so the order is the prefix the evidence supports. If nothing can be listed the entry is `insufficient-evidence` and `order` carries every observed model as evidence; the reason names what is missing.

Rule (b) exists because of how ADR 0020 applies the file: listed models move to the front and everything else keeps its configured order behind them. A model with too few trials that is configured behind the listed ones keeps its place, so it does not block. One configured ahead of them would be demoted without evidence: an eval run during which the configured head was unavailable would otherwise "learn" that the fallback is best. The reason then names the unmeasured model, and the fix is an eval in which that model serves.

**Output.** `config/routing.learned.json` in the shape ADR 0020 consumes. `mission` is the runtime mission id. The zod schema lives in `src/route-learn/schema.ts` and mirrors the runtime's `LearnedRoutingSchema`; when ADR 0020 lands, the evals package should import the runtime's schema and delete its copy. The file is written only by the command from real result files; none is committed from fixtures.

### 4. House playbooks for every mission

`loadShippedPlaybook(key)` and the web app's `readShippedPlaybook(key)` already resolve any key to `packages/runtime/playbooks/<key with ":" as ".">.house.json`. What was missing is a single definition of that mapping and of what makes a file valid, so the trainer writes exactly what the runtime reads. `packages/runtime/src/learning/house.ts` adds `housePlaybookFileName(key)` (which refuses a key that is not a playbook key, so a file name can never leave the folder), its inverse `housePlaybookKeyOfFile`, `parseHousePlaybook(key, raw)` (schema, key and scope must match) and `housePlaybookKeys(missionId, inputs)`. The trainer uses them to load parents and write promotions, and `/evals` uses them to list what is shipped; a training test promotes a playbook for every mission and loads each written file back through `parseHousePlaybook`. The two existing loaders keep their own copy of the mapping (they are outside this change's files); they should call these helpers.

### 5. `/evals`

Three sections read committed files at build time: **Training** (`results/training/*.json`: one row per step with promoted, rejected or inconclusive, the paired score difference with its interval, and the lineage of prompt and playbook versions per mission), **Live prompt versions** (the `RUNTIME_PROMPT_FILES` pointer per mission prompt, the versions on disk, which prompts are training targets, and a promoted version that still awaits its pointer change), and **Learned routing** (`config/routing.learned.json` with trials, pass rate, interval and latency per model and the reason for each decision). Each empty state shows the command that produces the data.

## Consequences

- Training is a deliberate operator action that needs live models; nothing here runs on a request path or in `pnpm check`. Tests use fake arms and scripted replays.
- A promotion is conservative by construction: with eight cases and three trials most real but small improvements will be rejected as unsupported. That is the intended error direction for prompts that ship to every user.
- A promoted prompt grows by one "Learned rules" section. Nothing prunes sections yet; a prompt that has collected several should be consolidated by hand into a new version and re-measured.
- Plain `pnpm eval` runs without playbooks, so after the first playbook promotion its results measure the mission without the shipped house guidance, while training arms measure it with. Baseline reuse accounts for this (a parent with a house playbook is never matched to a plain result file); making `pnpm eval` apply shipped house playbooks is a follow-up for the harness owner.
- Role attribution in result files comes from `servingFrom`, which maps a usage event to its step's role and defaults to `worker`. When ADR 0020 adds `role` to `usage.updated`, `servingFrom` should read it; routing evidence gets more exact with no change here.
- Historical result files (before per-trial serving) can rarely be attributed: every committed file so far shows two models for at least one role. Routing evidence effectively starts with the next full eval run.
- Known limits: the pool for a playbook step exists only where the baseline's event logs are on disk (they are git-ignored); arm duration estimates are estimates, and an arm that overruns is finished, not interrupted; shared prompts stay hand-tuned until a multi-mission gate exists.
- For the integrator: `apps/web/next.config.ts` traces `packages/runtime/prompts/**` into the deployment but not `packages/runtime/playbooks/**`. A promoted house playbook will not be found at run time on Vercel until that glob is added.
