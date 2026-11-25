# ADR 0009: Fork from step, replay and run compare, all from the event log

- Status: Accepted
- Date: 2026-11-25
- Builds on: ADR 0005 (event log and streaming), ADR 0007 (durable resume from the event log)

## Context

M4 asks for deterministic replay, fork-from-step and run compare, with a fork-and-diff starting in under 10 s. Production runs on Vercel serverless: 300 s per function, work scheduled with `after()`, no long-lived memory. ADR 0007 already makes a run resumable from its log alone: `analyseForResume` folds the events, completed steps come back from `step.completed.checkpoint`, everything else re-runs. A fork is the same problem with a different starting log.

## Decision

1. **A fork is a new run whose log starts as a copy of the parent's.** `planFork(parentEvents, { stepId, objective? })` (runtime, pure) returns every parent event with `seq` lower than the chosen step's first `step.started`, minus `run.created` and minus durable-resume markers (they would count against the fork's own resume limit). The web layer writes, in one transaction: the `runs` row (`parent_run_id`, `forked_from_seq` — columns that already exist, so no migration), a new `run.created`, the copied events with fresh `seq`, the artifact rows those events produced and the copied usage totals. Seeding is a single database copy; no model is called before the runner starts.
2. **The parent link lives in the log.** `run.created.payload.forkedFrom = { runId, stepId, parentSeq, seededThrough, objectiveEdited }`, optional and additive in `RunEventSchema`, folded into `RunState.forkedFrom`. No new event type, so the database's event-type check and exhaustive consumers are unchanged. The columns mirror it for queries; the log stays the source of truth.
3. **Editing the objective is a plan revision.** If the user changes the chosen step's objective, the seed ends with `plan.revised` (version + 1, `source: "reviewer"`, diff), which keeps approval, so the fork does not wait for a second plan approval.
4. **One executor.** The fork is scheduled through `executeRun({ resumeFrom })`, the path the stale-run sweeper uses; the live runner calls `resumeMission`, the simulated dev runner skips steps whose `step.completed` is in the log. Only finished runs (completed, failed or cancelled) can be forked, and only from a step that finished (succeeded or failed).
5. **Time to first new event is derived, not stored.** `seededThrough` is the last seq written by the fork. The fork banner shows `at(first event after seededThrough) - at(run.created)`; target under 10 s.
6. **Replay is client-side.** The run page already holds the full log. Replay slices it (`events.slice(0, cursor)`) and feeds the same `buildRunView` fold, so what replays is exactly what was recorded. Gaps between events are scaled by the chosen speed and clamped, so long tool calls do not stall playback. The view is labelled "Replay"; no request is made and no model is called.
7. **Compare reads two logs.** `/runs/compare?a=&b=` folds both and shows duration, steps, models, tokens, citation accuracy, sources and a claim diff of the final brief (or audit evidence). Claims are matched within a section: identical normalised text is unchanged, the best remaining pair with token Jaccard similarity of at least 0.5 is "changed", the rest are added or removed. Simple, deterministic and explainable in one sentence.

## Consequences

- A fork shares nothing mutable with its parent: artifacts are copied rows under the new run id, and the parent's log is never written.
- How much a fork reuses depends on the mission's restorability (ADR 0007, decision 4). Build-an-Agent restores completed steps from checkpoints; Company X-ray and the Automation Audit still re-run every step of the plan on resume. The fork banner reports reuse from the log (steps that completed in the seed and did not start again), so it never claims reuse that did not happen.
- Seeded events carry the fork's timestamp, not the parent's: the fork's duration is its own wall-clock time, and the parent's step timings stay on the parent.
- Budgets: copied usage is in the fork's totals but, as with resume, is not charged against the fork's runtime budget.
- Replay of very long logs keeps the whole log in memory in the browser; fine at demo scale (hundreds of events).
- The claim diff is lexical. Paraphrases below the similarity threshold show as one removal plus one addition; that is the honest failure mode.
