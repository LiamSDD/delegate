# ADR 0020: Agent teams, a run blackboard, one typed-output path and learned routing

- Status: Accepted
- Date: 2026-11-25
- Builds on: ADR 0001 (hand-written runtime), ADR 0003 with Amendments 2 to 3b (roles, ranked chain, max quality), ADR 0006 (planner, orchestrator, critic), ADR 0007 (durable runs from the event log), ADR 0013 (evolving playbooks), ADR 0015 (deep research, review-and-repair)

## Context

Six gaps in the runtime that every mission runs on, each found by reading the code at `ef131fc`:

1. **Fan-out is ad hoc.** A plan step is one sub-agent. Custom goal's `research_topic` searches up to three topics one after another in a single tool call and shares four reference sources among them in query order, so with two hits per topic the third topic gets none. Nothing in the plan says "this step is three researchers", so a reviewer cannot see or bound it.
2. **Sub-agents get strings.** Each executor assembles its own prompt from `inputs`, and the only shared context is `guidance?: string[]`, which one executor reads. There is no single, typed statement of what the run knows.
3. **Typed output has two code paths and loses data quietly.** `callStructured` parses and repairs; the review turn of `callStructuredReviewed` makes its own model call and validation. An answer cut off at the token limit is "repaired" by closing the open string, so half a sentence can pass as a value. Provider JSON modes are not used. Tool-call arguments that are not valid JSON are refused and cost the agent a loop iteration. A follow-up call is made even when the step budget cannot pay for it, and the answer is then thrown away by the budget check.
4. **No check before hand-off.** A sub-agent's result goes to the next step without anyone comparing it with the step's acceptance criteria.
5. **One model order for everything.** The chain order is the bake-off of ADR 0003 (eight calls per model, ranks one to three within noise), identical for every mission and role. Eval results now record which model served each trial, but nothing reads them back.
6. **Max quality is inconsistent.** A quality-critical call routes its own role with `latency: "offline"`. Only the `planner` chain starts with an offline entry. Repo X-ray's ranking step (`improve`) asks with the `worker` role, so in max mode it is still served by the interactive head and never says "Max quality".

ADR 0001 requires that a reviewer can read the agent loop in one sitting, so every addition below is its own small module; `loop.ts` gains one call.

## Decision

### 1. Agent teams: a plan step may declare a bounded fan-out

A plan step may carry `team`:

```json
{ "size": 3, "from": "resolve_target", "reducer": "merge_findings", "memberTokens": 20000, "memberMs": 60000 }
```

- `size` is the most members the step may spawn. `from` names the earlier step whose output the sub-objectives are derived from. `reducer` names how the members' typed results are merged. `memberTokens` and `memberMs` are each member's token and wall-clock budget.
- The field lives on `PlanStep` because the plan is what a human approves and what replay shows. It is optional, so every existing log and plan parses unchanged.
- **Validation** (`validateTeams`, called by `validatePlan`, therefore also by `checkPlanSteps`, planner output, revisions and reviewer edits): the step's library entry must allow a team and that reducer; `size` is 2 to 6 and at most the entry's own maximum; the sizes of all teams in a plan sum to at most 12; `memberTokens` is 2,000 to 60,000; `memberMs` is 5 to 120 s; `from` is one of the step's transitive inputs.
- **Execution** (`agent/team.ts`). The orchestrator hands the executor a `TeamHandle` on its task. The executor supplies the assignments (code derives them from its inputs; no model call), the member function and optionally its own reducer. The handle does the rest: at most `size` members, at most 12 team members in a run counted at run time as well, at most four at once; each member is announced with the existing `agent.spawned` and `agent.message` events on the step; each member's grant is the step's own grant or a subset of it, never more; each member runs on a context whose abort signal fires at its deadline and whose budget charges the step's budget and stops at the member's allowance; each result is parsed with `SubAgentResultSchema`. A member that fails, times out or overruns its allowance is reported and left out; the step fails only on a fatal error, as before.
- **Reducer.** `merge_findings`: findings in member order without duplicates (same first citation and quote, or same text), sources by id, artifacts by id, confidence as the mean of the members that finished.
- **Durability.** The unit of checkpoint stays the step (ADR 0007): the merged result is the `step.completed` checkpoint. A finished team step is restored and never re-run; one in flight at a crash runs again with all its members. Fork and replay need nothing new, because members are ordinary sub-agent events on a known step and the declaration travels with the plan step.
- **Planner.** A library entry that allows a team shows `"team": {"maxMembers", "reducers"}`; other entries are unchanged, so prompts of missions without teams are byte-identical. `planner.v4` documents the field and stays `draft`; switching `RUNTIME_PROMPT_FILES.planner` is a reviewed one-line commit after an eval (ADR 0013). Under the active `planner.v3` a team enters a plan through the mission's reference plan.
- **Adopted in Custom goal.** `research_topic` becomes a team of one researcher per topic the goal names (two or three), each scoped to the company `resolve_target` resolved. Each member searches its own topic and reads its own articles in quarantine. The total of reference sources read stays four, split fairly across members, so the team makes no more reader calls than before. General topic articles are still fetched only when no member found an article about the company (ADR 0015, decision 3). A goal with one topic, or a plan whose reviewer removed `team`, runs the previous single-agent path.

### 2. Run blackboard

`agent/blackboard.ts` builds a typed view of what the run knows from the event log alone:

- **Facts**: findings of completed steps that are reader output (`trust: "untrusted"`, with a citation and a quote), as `{id, stepId, sourceId, topic, claim, trust}`. The quote is verbatim page text, so it is left out. A claim that trips `detectInjection` is withheld and counted.
- **Sources**: `{sourceId, kind, host}`. Titles and paths are page-controlled and are left out.
- **Decisions** and **open questions**: built by code from templates whose slots accept only identifiers, enums and numbers, the rule lessons already follow (ADR 0013): plan versions and who approved them, step outcomes with confidence, policy denials per tool, unresolved approvals, failed and pending steps, critic and research numbers, model fallbacks per reason.
- **Artifacts**: `{artifactId, kind, version, stepId}`, never content.

`renderBlackboard(board, { maxTokens })` is deterministic (stable order, no clock, no ids that change between runs) and capped: decisions and open questions first, then facts round-robin by source until the cap. The emitter keeps the validated, redacted drafts it has enqueued (`history()`), seeded with the stored log on resume, so the view is rebuilt from the log and from nothing else. Every `SubAgentTask` and every team member receives `blackboard`. It is used by the self-check and by team members; existing executors keep their own prompts until their missions are migrated.

### 3. One code path for typed model output

`agent/structured.ts` runs one pipeline for both exported functions:

1. **Call** with `responseFormat: json_object`. The router passes it on only to entries that carry the quirk `json-object`; the OpenAI-compatible adapter then sends `response_format: {"type": "json_object"}`. If a provider rejects the parameter (HTTP 400 or 422 naming it), the adapter retries that request once without it and stops sending it to that model.
2. **Read** (`agent/json-repair.ts`): strict parse, fenced block, syntax repairs (comments, trailing commas, bare or half-quoted keys, single quotes, `True`/`False`/`None`, text around the value), then balancing. Balancing never invents the end of a value: an answer that stops inside a string or after a key is cut back to the last complete element before the brackets are closed, and is marked truncated.
3. **Fit to the schema** (`agent/schema-repair.ts`): when validation fails, the zod issues guide type-level repairs that keep the information (number or boolean written as a string, a JSON value double-encoded as a string, `null` for an optional field, one object where an array of them is expected, a known wrapper key around the value, a bare array where the schema is an object with one array field, enum values differing only by case), then the value is validated again.
4. **One follow-up turn**, only if the step budget can pay for the prompt: after a truncated answer, "continue from where it stopped, or restate shorter" and the reply is used alone or joined to the partial answer with overlap removed; otherwise the validation issues, as before. A stream that fails mid-answer is retried once after a short backoff on the fast chain.
5. **Review turn** (ADR 0015 addendum), unchanged in behaviour, now through the same call and read.

The number of model calls per typed output is never higher than before: one when the answer can be read, two with a follow-up, three with a review turn.

**Tool-call arguments** (`agent/tool-args.ts`, one call in `loop.ts`): arguments that are not valid JSON or do not fit the tool's schema get the syntax and schema repairs above before the policy check sees them. Arguments that look cut off are never completed; the call is refused as before.

**Provider JSON modes, from current documentation (2026-11-25).** Ollama's OpenAI-compatible endpoint lists `response_format`, JSON mode and streaming as supported, so its entries carry `json-object`. Cloudflare Workers AI states that JSON mode does not support streaming, and the adapter always streams, so it must not be enabled there. Groq and Cerebras document `json_object` but not its use with streaming; OpenRouter documents `json_schema` only and fails the request on a model without support; NVIDIA's support depends on the model; Pollinations' classic endpoint does not document it. Those stay off until a live probe confirms them. Anthropic has no JSON-object mode; its schema mode stays as it is.

### 4. Self-check before hand-off

`agent/self-check.ts`: after a step executor returns, and only for library entries that set `selfCheck: true`, one `fast` call receives the step's objective, its acceptance criteria and a capped rendering of the result (counts, confidence, at most 20 findings tagged with their trust). It answers `{"criteria": [{"index", "met"}]}` and nothing else. If a criterion is not met, the executor runs once more with the unmet criteria, copied verbatim from the plan, in `task.feedback` and `task.guidance`; the second result is kept unless its confidence is lower. No model-written text reaches the executor.

The check is skipped, with a reason in an `agent.message`, when the step has no acceptance criteria, when the mission clock cannot fit one more fast call and one more run of the step, when the step budget cannot pay for the prompt, or when no model answers. No library entry sets `selfCheck` today: see Measurements.

### 5. Learned routing

The router orders a role's chain with `config/routing.learned.json` when the file exists:

```json
{ "version": 1, "generatedAt": "2026-11-25T10:00:00Z", "source": { "resultFiles": ["..."], "trials": 120 }, "minTrials": 20,
  "entries": [ { "mission": "company-xray", "role": "worker",
    "order": [ { "provider": "nvidia", "model": "…", "trials": 40, "passRate": 0.9, "ci": [0.77, 0.96], "p50LatencyMs": 8200 } ],
    "decision": "learned", "reason": "…" } ] }
```

- `LearnedRoutingSchema` (exported from `@delegate/runtime`) is strict: unknown keys, a pass rate outside 0 to 1, an interval whose lower bound exceeds its upper bound, two entries for one mission and role, or one model twice in an order make the file invalid.
- **Rule** (`routing/learned.ts`, applied in `ModelRouter.open` to the chain `resolveChain` returned): for the run's mission and the call's role, if the entry's decision is `learned`, the listed models that are in the resolved chain come first in the listed order; every other entry keeps its configured order after them. A listed model that is not in `config/models.json` for that role is ignored. Because the rule reorders the resolved chain and never adds to it, an entry marked `interactive: false` cannot enter an interactive call, a provider without a key cannot appear, and a public-demo chain stays a public-demo chain.
- **Absent or invalid file**: the configured order is used, exactly as before, and one line is logged per process (`console.warn`, injectable).
- **Loading**: `routing/load.ts` reads the file next to `config/models.json` once per process. `RunMissionOptions.learnedRouting` overrides it (`null` turns it off), the same way `modelsConfig` overrides the chain, so a bundled deployment can pass the JSON it imported.
- **Attribution**: `usage.updated` gains optional `role` and `ordering` (`"configured"` or `"learned"`), and `model.fallback` gains `ordering`. `ordering` is `learned` only when an entry was applied to that call's chain. No new event type and no migration.
- Reflection and assistant chat have no mission and keep the configured order.

### 6. Max quality leads with the role's offline entry

In `max`, a quality-critical call still routes its own role with `latency: "offline"`, and now also asks the router to lead with that role's first offline-latency entry (`interactive: false`), wherever it sits in the configured or learned order. The rest of the chain keeps its order, so a head that misses its deadline still falls back to the normal chain (Amendment 3). For the `planner` chain nothing changes: Kimi K3.1 Pro already leads. For `worker` and `fast` the first offline entry (today Step 5 Preview) now leads, which is what makes Repo X-ray's `improve` consistent with the other design, ranking and synthesis steps. The repair and review turns stay on the interactive chain, as before. Ship-a-PR has no such step (its only model step is the Engineer's tool loop, which must stay interactive) and Autopilot makes no model call of its own; a test per mission pins all seven.

## Measurements

All numbers are from scripted models and fixtures in the repository; no live model was called in this work (there is no key in the worktree). They are added by the commits that land each bench.

## Consequences

- A team multiplies a step's parallel work but not its authority or its budget: capabilities are the step's, tokens are charged to the step, and the plan shows the bound a human approved.
- The blackboard can say "S3, offering: leases start at 1,900 EUR" and "step fill_gaps failed", never what a page's title or a model's free text said. That is the same trade ADR 0013 made for lessons.
- A cut-off answer now yields fewer, complete items instead of the same items with a broken last one. Callers that count items see the smaller count and their existing shortfall handling applies.
- Learned routing can only reorder models that the configuration, the audience, the data classification and the latency mode already allow. A bad file costs nothing but the log line.
- In max mode a `worker` or `fast` quality step waits for that role's offline entry. Only Repo X-ray's `improve` is affected today.
- Three payloads gain optional fields (`PlanStep.team`, `usage.updated.role` and `.ordering`, `model.fallback.ordering`). `packages/runtime/src/events.ts` had to change for that; consumers that ignore unknown fields are unaffected.
