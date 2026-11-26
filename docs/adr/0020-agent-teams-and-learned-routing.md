# ADR 0020: Agent teams, a run blackboard, one typed-output path and learned routing

- Status: Accepted
- Date: 2026-11-25 (measurements added 2026-11-26)
- Builds on: ADR 0001 (hand-written runtime), ADR 0003 with Amendments 2 to 3b (roles, ranked chain, max quality), ADR 0006 (planner, orchestrator, critic), ADR 0007 (durable runs from the event log), ADR 0013 (evolving playbooks), ADR 0015 (deep research, review-and-repair)

## Context

Six gaps in the runtime that every mission runs on, each found by reading the code at `ef131fc`:

1. **Fan-out is ad hoc.** A plan step is one sub-agent. Custom goal's `research_topic` searches up to three topics one after another in a single tool call and shares four reference sources among them in query order, so with two hits per topic the third topic gets none. Nothing in the plan says "this step is three researchers", so a reviewer cannot see or bound it.
2. **Sub-agents get strings.** Each executor assembles its own prompt from `inputs`, and the only shared context is `guidance?: string[]`, which one executor reads. There is no single, typed statement of what the run knows.
3. **Typed output has two code paths and loses data quietly.** `callStructured` parses and repairs; the review turn of `callStructuredReviewed` makes its own model call and validation. An answer cut off at the token limit is "repaired" by closing the open string, so half a sentence can pass as a value. Provider JSON modes are not used. Tool-call arguments that are not valid JSON are refused and cost the agent a loop iteration. A follow-up call is made even when the step budget cannot pay for it, and the answer is then thrown away by the budget check.
4. **No check before hand-off.** A sub-agent's result goes to the next step without anyone comparing it with the step's acceptance criteria.
5. **One model order for everything.** The chain order is the bake-off of ADR 0003 (eight calls per model, ranks one to three within noise), identical for every mission and role. Eval results now record which model served each trial, but nothing reads them back.
6. **Max quality is inconsistent.** A quality-critical call routes its own role with `latency: "offline"`. Only the `planner` chain starts with an offline entry. Repo X-ray's ranking step (`improve`) asks with the `worker` role, so in max mode it is still served by the interactive head and never says "Max quality".

ADR 0001 requires that a reviewer can read the agent loop in one sitting, so every addition below is its own small module. `loop.ts` gains one call (two lines); `orchestrator.ts` gains the task assembly for teams, the blackboard and the self-check (about forty lines).

## Decision

### 1. Agent teams: a plan step may declare a bounded fan-out

A plan step may carry `team`:

```json
{ "size": 3, "from": "resolve_target", "reducer": "merge_findings", "memberTokens": 20000, "memberMs": 60000 }
```

- `size` is the most members the step may spawn. `from` names the earlier step whose output the sub-objectives are derived from. `reducer` names how the members' typed results are merged. `memberTokens` and `memberMs` are each member's token and wall-clock budget.
- The field lives on `PlanStep` because the plan is what a human approves and what replay shows. It is optional, so every existing log and plan parses unchanged.
- **Validation** (`validateTeams` in `agent/team.ts`, called by `validatePlan`, therefore also by `checkPlanSteps`, planner output, revisions and reviewer edits): the step's library entry must allow a team and that reducer; `size` is 2 to 6 and at most the entry's own maximum; the sizes of all teams in a plan sum to at most 12; `memberTokens` is 2,000 to 60,000; `memberMs` is 5 to 120 s; `from` is one of the step's transitive inputs. The event schema itself only requires positive integers and a known reducer, so that a cap can be explained to the planner in its repair turn instead of failing as a bare schema error.
- **Execution** (`createTeamHandle`). The orchestrator hands the executor a `TeamHandle` on its task when the plan step declares a team and the library entry allows one. The executor supplies the assignments (code derives them from its inputs; no model call), the member function and optionally its own reducer. The handle does the rest: at most `size` members for the step however often it is called, at most 12 team members in a run counted at run time as well, at most four at once; each member is announced with the existing `agent.spawned` and `agent.message` events on the step; each member's grant is the step's own grant or a subset of it, never more; each member runs on a context whose abort signal fires at its deadline and whose budget charges the step's budget and stops at the member's allowance; each result is parsed with `SubAgentResultSchema`. A member that fails, times out or overruns its allowance is reported in an `agent.message` and left out; the step fails only on a fatal error (a fatal step error, an exhausted run budget, a cancelled run), as before.
- **Reducer.** `merge_findings`: findings in member order without duplicates (same first citation and quote, or same text), sources by id, artifacts by id, confidence as the mean of the members that finished.
- **Durability.** The unit of checkpoint stays the step (ADR 0007): the merged result is the `step.completed` checkpoint. A finished team step is restored and never re-run; one in flight at a crash runs again with all its members. Fork and replay need nothing new, because members are ordinary sub-agent events on a known step and the declaration travels with the plan step. Tests in `agent/team.test.ts` cover resume before and after the step and a fork from it.
- **Approval.** Adding or widening a team in a revision does not by itself ask for re-approval: a team changes how much runs in parallel, never which capabilities a step holds, and `revisionApproval` (ADR 0015) keeps deciding on capabilities.
- **Planner.** A library entry that allows a team shows `"team": {"maxMembers", "reducers"}`; other entries are unchanged, so prompts of missions without teams are byte-identical. `planner.v4` documents the field and stays `draft`; switching `RUNTIME_PROMPT_FILES.planner` is a reviewed one-line commit after an eval (ADR 0013). Under the active `planner.v3` a team enters a plan through the mission's reference plan; a planner answer that breaks a cap gets the usual repair turn and then the default plan.
- **Adopted in Custom goal.** `research_topic` becomes a team of one researcher per topic the goal names (two or three). With a resolved company, each member searches its own topic together with the company and reads its own articles in quarantine; without one, each member searches its own topic. The total of reference sources read stays four, split fairly across members (2+2, or 2+1+1), so the team makes no more reader calls than before. General topic articles for a company goal are still fetched only when no member found an article about the company (ADR 0015, decision 3); that fallback runs on the previous single-agent path. A goal with one topic, or a plan from which the reviewer or the planner removed `team`, runs the previous single-agent path.

### 2. Run blackboard

`agent/blackboard.ts` builds a typed view of what the run knows from the event log alone:

- **Facts**: findings of completed steps that are reader output (`trust: "untrusted"`, with a citation and a quote), as `{id, stepId, sourceId, topic, claim, trust}`. The quote is verbatim page text, so it is left out. A claim that trips `detectInjection` is withheld and counted. A topic that is not a plain identifier is dropped, and angle brackets are removed from claims so that a claim cannot close the block it is rendered in.
- **Sources**: `{sourceId, kind, host}`. Titles and paths are page-controlled and are left out.
- **Decisions** and **open questions**: built by code from templates whose slots accept only identifiers, enums and numbers, the rule lessons already follow (ADR 0013): plan versions and who approved them, step outcomes with confidence, policy denials per tool, critic and research numbers, model fallbacks per reason; failed, running and not-yet-run steps, steps that asked for a replan, plans and approvals waiting for a human. A tool name a model invented is shown as `unnamed`.
- **Artifacts**: `{artifactId, kind, version, stepId}`, never content.

`renderBlackboard(board, { maxTokens })` is deterministic (stable order, no clock, no ids that change between runs) and capped at `maxTokens × 4` characters, the estimate the router already uses: decisions and open questions get at most half the room, then facts round-robin by source until the cap, then the sources of the facts shown and the artifacts.

The emitter keeps the validated, redacted drafts it has enqueued (`history()`), seeded with the stored log on resume, so the view is rebuilt from the log and from nothing else. Every `SubAgentTask` and every team member receives `blackboard()`; it is built only when called, so a step that does not use it pays nothing.

No existing prompt was changed to include the rendering. Putting it into a synthesis, critic or researcher prompt is a prompt change, which needs a new prompt version and a live eval (ADR 0013), and no live model was available for this work. The blackboard is therefore delivered as the typed, tested interface that the next prompt version of a mission can use in place of its own strings; `guidance` stays as it is until then.

### 3. One code path for typed model output

`agent/structured.ts` runs one pipeline for both exported functions:

1. **Call** with `responseFormat: json_object`. The router passes it on only to entries that carry the quirk `json-object`; the OpenAI-compatible adapter then sends `response_format: {"type": "json_object"}`. If a provider rejects the parameter (HTTP 400 or 422 whose body names it), the adapter retries that request once without it and stops sending it to that model.
2. **Read** (`agent/json-repair.ts`): a strict parse, then a tolerant parser that accepts comments, trailing and missing commas, bare or half-quoted keys, single quotes, `True`/`False`/`None`, raw newlines and unescaped inner quotes in strings, a missing closing bracket and text around the value (the longest JSON value in the text wins). It never invents the end of a value: an answer that stops inside a string, a number, a literal or after a key keeps only its complete elements, an array keeps only complete items, and the reading is marked truncated.
3. **Fit to the schema** (`agent/schema-repair.ts`): when validation fails, the zod issues guide type-level repairs that keep the information (number or boolean written as a string and the reverse, a JSON value double-encoded as a string, `null` for an optional field, one value where an array of them is expected, a known wrapper key around the value, a bare array where the schema is an object with one array field, enum values differing only by case or separators when exactly one value matches, unknown keys in a strict object), then the value is validated again. The caller's value is never mutated, and an answer that still fails is reported with its original issues.
4. **One follow-up turn**, only if the step budget can pay for its prompt: after an answer that was cut off and could not be used, "continue exactly where it stopped, or restate shorter", and the reply is joined to the partial answer with a repeated tail removed, or used alone when it is a restatement; otherwise the validation issues, as before. When the budget cannot pay, the call fails with the validation issues instead of spending tokens on an answer the budget check would discard. A stream that fails mid-answer is retried once after one second on the interactive chain.
5. **Review turn** (ADR 0015 addendum), unchanged in behaviour, now through the same call and read, and skipped when the step budget cannot pay for it.

A typed output costs one model call when the answer can be read, two with a follow-up, three with a review turn, as before. The one place where the new path makes a call the old one did not is an answer the old reader accepted wrongly (see the bench).

**Tool-call arguments** (`agent/tool-args.ts`, one call in `loop.ts`): arguments that are not valid JSON or do not fit the tool's schema get the syntax and schema repairs above before the capability and policy checks see them, and the repaired JSON is what is echoed back to the model on the next turn. Arguments that were cut off are never completed; the call is refused as before.

**Provider JSON modes, from current documentation.** Ollama's OpenAI-compatible endpoint lists `response_format`, JSON mode and streaming as supported (checked 2026-11-26), so its three entries carry `json-object`. Cloudflare Workers AI states that JSON mode does not support streaming (checked 2026-11-26), and the adapter always streams, so it must not be enabled there. NVIDIA, Pollinations, Groq, Cerebras and OpenRouter stay off until a live probe confirms JSON mode together with streaming for the model in question; the quirk is one line per entry in `config/models.json`. Anthropic has no JSON-object mode; its schema mode stays as it is. On the default keyless chain nothing changes.

### 4. Self-check before hand-off

`agent/self-check.ts`: after a step executor returns, and only for library entries that set `selfCheck: true` in a mission that passes a self-check prompt to the mission runner, one `fast` call (`self-check.v1`, draft) receives the step's objective, its acceptance criteria and a capped rendering of the result (counts, confidence, at most 20 findings tagged with their trust, without quotes). It answers `{"criteria": [{"index", "met"}]}` and nothing else. If a criterion is not met, the executor runs once more with the unmet criteria, copied verbatim from the plan, in `task.unmetAcceptance` and `task.guidance`; the second result is kept unless its confidence is lower or the second run fails. No model-written text reaches the executor.

The check is skipped, with the reason in an `agent.message`, when the step has no acceptance criteria, when the mission clock cannot fit one more fast call and one more run of the step, when the step budget cannot pay for the prompt, or when no model gives a usable verdict. No library entry sets `selfCheck` today: see Measurements.

### 5. Learned routing

The router orders a role's chain with `config/routing.learned.json` when the file exists:

```json
{ "version": 1, "generatedAt": "2026-11-25T10:00:00Z", "source": { "resultFiles": ["..."], "trials": 120 }, "minTrials": 20,
  "entries": [ { "mission": "company-xray", "role": "worker",
    "order": [ { "provider": "nvidia", "model": "…", "trials": 40, "passRate": 0.9, "ci": [0.77, 0.96], "p50LatencyMs": 8200 } ],
    "decision": "learned", "reason": "…" } ] }
```

- `LearnedRoutingSchema` (exported from `@delegate/runtime`) is strict: unknown keys, a pass rate outside 0 to 1, an interval whose lower bound exceeds its upper bound, two entries for one mission and role, or one model twice in an order make the file invalid.
- **Rule** (`routing/learned.ts`, applied by the router to the chain `resolveChain` returned): for the run's mission and the call's role, if the entry's decision is `learned`, the listed models that are in the resolved chain come first in the listed order; every other entry keeps its configured order after them. A listed model that is not in `config/models.json` for that role is ignored. Because the rule reorders the resolved chain and never adds to it, an entry marked `interactive: false` cannot enter an interactive call, a provider without a key cannot appear, and a public-demo chain stays a public-demo chain. The per-provider concurrency gate and the planner's pacing estimate read the same ordered chain, so they follow the head that will actually serve.
- **Absent or invalid file**: the configured order is used, exactly as before, and one line is logged per process (`console.warn`, injectable).
- **Loading**: `routing/load.ts` reads the file next to `config/models.json` once per run. `RunMissionOptions.learnedRouting` overrides it (`null` turns it off), the same way `modelsConfig` overrides the chain. The web app bundles its configuration and passes `modelsConfig`; until it also passes `learnedRouting`, learned routing applies to evals, the CLI and other unbundled hosts only.
- **Attribution**: `usage.updated` gains optional `role` and `ordering` (`"configured"` or `"learned"`), and `model.fallback` gains `ordering`. `ordering` is `learned` only when an entry was applied to that call's chain. No new event type and no migration.
- Reflection and assistant chat have no mission and keep the configured order.

### 6. Max quality leads with the role's offline entry

In `max`, a quality-critical call still routes its own role with `latency: "offline"`, and now also asks the router to lead with that role's first offline-latency entry (`interactive: false`), wherever it sits in the configured or learned order. The rest of the chain keeps its order, so a head that misses its deadline still falls back to the normal chain (Amendment 3). For the `planner` chain nothing changes: Kimi K3.1 Pro already leads. For `worker` and `fast` the first offline entry (today Step 5 Preview) now leads, which is what makes Repo X-ray's `improve` consistent with the other design, ranking and synthesis steps. The repair and review turns stay on the interactive chain, as before.

Each model-using mission has an end-to-end test that runs it in max quality on a chain whose offline entry sits behind the interactive head and asserts exactly which steps that entry served: `synthesise` (Company X-ray, Custom goal), `rank` (Automation Audit), `design` (Build-an-Agent), `architect` and `improve` (Repo X-ray). Ship-a-PR has no such step (its only model step is the Engineer's tool loop, which must stay interactive) and Autopilot makes no model call of its own; `agent/max-quality.missions.test.ts` pins both, and the number of quality-critical calls per mission, at source level.

## Measurements

All numbers are from scripted models and fixtures in the repository. No live model was called in this work: there is no key in the worktree. They show what the code does with a given answer, not how often live models give such answers.

### Typed-output reliability bench (`agent/reliability/bench.test.ts`)

The corpus is 39 model answers in `agent/reliability/fixtures/outputs/`, written by hand after the failure classes the repository records (the half-quoted key pinned in `structured.test.ts`, answers cut at the token limit and reasoning-only answers from ADR 0003 Amendment 3, items that did not fit the schema from the ADR 0015 addendum) and the usual JSON damage of open-weight models. The event log does not store raw model text, so there is no live capture to replay; the corpus is deliberately weighted towards damaged answers (7 controls the old reader already handled, 9 syntax, 9 shape, 9 truncated, 5 unusable) and is not a sample of production traffic. "Before" is the reader and call flow at `ef131fc`, copied into the bench; "after" is `callStructured`. Each answer has the set of values a correct reading may return; a scripted follow-up reply stands in for the model's second turn, so the follow-up columns are an upper bound for both.

| | Before | After |
|---|---|---|
| Correct value from the first call | 7 of 39 (18%) | 29 of 39 (74%) |
| Correct value after the follow-up turn | 27 | 9 |
| Correct value in total | 34 of 39 (87%) | 38 of 39 (97%) |
| Accepted but wrong | 4 (10%) | 0 |
| Failed after the follow-up | 1 | 1 |
| Model calls for the 39 outputs | 67 | 49 |

The four wrong values of the old reader are all cut-off answers closed by guesswork: a half sentence as a reason, a half sentence as a claim, a cut quote passed as verbatim, and `1` for a number that was going to be `12`. The last one is the only answer for which the new path makes a call the old one did not. The one failure in both columns is an answer whose scripted follow-up is wrong again. The seven controls take one call before and after.

Tool-call arguments (12 calls in `fixtures/tool-arguments.json`): before, 2 run and 10 are refused; after, 9 run with the intended arguments and 3 are refused, which are the three that must be (cut off, wrong field, not a URL). None is accepted with arguments other than the intended ones.

### Agent team in Custom goal (`missions/custom-goal/run.test.ts`)

Goal "Improve acme's marketing, pricing and hiring" on the fixture web, where every topic has two reference articles about the company:

| | Single agent | Team of three |
|---|---|---|
| Topics with at least one source read | 2 of 3 | 3 of 3 |
| Reference sources read | 4 | 4 |
| Reader (model) calls in the step | 4 | 4 |
| Search tool calls, each policy-checked | 1 | 3 |

The team costs no extra model call and covers the topic the single agent left out. It makes two more Wikipedia extract requests (one per member instead of one for all). Wall-clock gain from running members in parallel cannot be measured with scripted models. The mission's existing tests and the red-team suite (110 attacks, 0.0%) pass unchanged; the existing end-to-end test now goes through the team and its general-article fallback.

### Self-check (`agent/self-check.test.ts`)

Six fixture results for a step with two acceptance criteria, three of which meet them. The check costs exactly one fast call per checked step and one more run of the step per send-back, and nothing when skipped.

| Judge | Fast calls | Extra step runs | Results meeting the criteria |
|---|---|---|---|
| none (no self-check) | 0 | 0 | 3 of 6 |
| always right | 6 | 3 | 5 of 6 |
| always passes | 6 | 0 | 3 of 6 |
| always fails | 6 | 6 | 5 of 6 |

The benefit depends entirely on how well a fast model judges acceptance criteria, which fixtures cannot tell, and a judge that fails too often doubles the cost of a step. So the mechanism is in place and tested, and no library entry opts in: the default path makes no extra model call. Turning it on for a step is one flag on the library entry and one prompt in the mission's run options, to be decided by a live eval.

### Learned routing and max quality

No measurement applies: there is no `config/routing.learned.json` yet, and without one the router is byte-for-byte the configured order (pinned in `routing/router-learned.test.ts`). Max quality is pinned per mission as described above.

## Consequences

- A team multiplies a step's parallel work but not its authority or its budget: capabilities are the step's, tokens are charged to the step, and the plan shows the bound a human approved. The web plan card does not show the team yet; its members appear as agents on the step while it runs.
- The blackboard can say "S3, offering: leases start at 1,900 EUR" and "step fill_gaps failed", never what a page's title or a model's free text said. That is the same trade ADR 0013 made for lessons. It has no prompt consumer yet.
- A cut-off answer now yields fewer, complete items instead of the same items with a broken last one. Callers that count items see the smaller count and their existing shortfall handling applies.
- Type repairs accept answers that used to cost a second call. A value that is repaired is still validated by the same schema, and every claim still goes through the same code checks and the critic.
- A typed call that cannot afford its follow-up now fails with `StructuredOutputError` where it used to fail with a step budget error after spending the tokens. Callers treat both as "this output is not available".
- Learned routing can only reorder models that the configuration, the audience, the data classification and the latency mode already allow. A bad file costs nothing but the log line.
- In max mode a `worker` or `fast` quality step waits for that role's offline entry. Only Repo X-ray's `improve` is affected today.
- Three payloads gain optional fields (`PlanStep.team`, `usage.updated.role` and `.ordering`, `model.fallback.ordering`). `packages/runtime/src/events.ts` had to change for that; consumers that ignore unknown fields are unaffected. No run event type was added and no migration is needed.
