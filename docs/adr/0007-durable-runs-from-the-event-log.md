# ADR 0007: Durable runs from the event log, without a job service

- Status: Accepted
- Date: 2026-11-24
- Amends: ADR 0005 (consequence "true resume comes with M3"); SPEC §5 ("runs are durable jobs (Inngest)")

## Context

M3 requires that killing the server mid-run still completes the run. The spec planned Inngest for this. Inngest's free tier needs an account and a signing key, and the hosted path routes run state through a third party. ADR 0003 makes $0 and keyless binding: nothing on the default path may need an account. The event log (`run_events`) is already the single source of truth for the UI, traces and replay (ADR 0005), and every event is written before it is published.

## Decision

1. **Checkpoints are events.** When a step succeeds, the orchestrator writes `step.completed` with an optional `checkpoint` field holding the step's full `SubAgentResult` (`summary`, `findings`, `sources`, `confidence`, `artifacts`). The field is optional and additive, so old logs and consumers are unaffected. Everything a dependent step needs is either in a checkpoint or in an artifact's content, which is also in the log (`artifact.created` / `artifact.updated`).
2. **`resumeMission({ runId, events, ...runMission deps })`** folds the log (`analyseForResume`):
   - terminal runs return their status and emit nothing;
   - no plan yet: the mission starts normally;
   - plan proposed but not approved: the approval hook is asked again, no new `plan.proposed`;
   - plan approved: completed steps are restored from their checkpoints and never re-run; steps that failed stay failed; steps that started but did not complete (in flight at the crash) run again from scratch.
3. **In-flight steps are idempotent by construction.** Tool calls are reads. The crawler's fetch cache is the `documents` table itself, keyed by `(workspace_id, collection, source_url)`: a re-run crawl reuses stored pages (and their stored links, for breadth-first discovery) instead of fetching them again. A re-run step that publishes an artifact it already created updates that artifact (`artifact.updated`, next version) instead of creating a duplicate.
4. **Missions declare restorability.** A mission is restorable when every executor gets its state only from inputs and artifacts. Build-an-Agent is written that way. Company X-ray and the Automation Audit still keep per-run state in closures (the research kit's source store), so on resume they re-run every step of the approved plan; this is correct but not cheap, and is listed as a known gap.
5. **Lease, so one worker resumes a run.** `runs.lease_owner` and `runs.lease_expires_at` (migration 0004) hold a time-bound lease. `createDbRunLease` claims it with one conditional `UPDATE ... WHERE lease_owner IS NULL OR lease_owner = $me OR lease_expires_at < now()`, so the database decides atomically. `resumeMission({ lease })` acquires it (or returns `status: "busy"`), renews it every `ttl/3`, and releases it at the end. A worker that loses its lease aborts and its later events are dropped, so a stale worker cannot write a terminal event over the new owner's run. A column, not a new event type, because the lease is coordination state with a TTL rather than history, and a new `RunEvent` type would change the database's event-type check and every exhaustive consumer.
6. **Who calls resume.** Whatever process notices a non-terminal run with an expired lease: the web app's stale-run sweeper (replacing ADR 0005's "mark failed after timeout"), a cron, or a CLI. No job service is required.

## Why not Inngest (now)

- It needs an account and keys; ADR 0003 forbids that on the default path, and self-hosters would need to run the Inngest dev server or its self-hosted stack.
- Our state already lives in an append-only log with checkpoints; Inngest's step memoisation would duplicate it in a second store we do not control.
- **Inngest remains a drop-in later:** each plan step maps to one `step.run(stepId, ...)` whose memoised value is the checkpoint, and `resumeMission` is what an Inngest function would call on retry. Adding it is a deployment choice, not a runtime change.

## Consequences

- A crash costs at most the in-flight steps. Measured on plausible.io (owner chain, 2026-11-25): a run killed after `design` (107 s, 204 events) resumed in 40 s, skipped `crawl`, `index` and `design`, re-ran only `evalset`, `evaluate` and `gaps`, fetched no page twice and completed.
- `step.completed` payloads grow (a few KB to tens of KB per step). Acceptable at demo scale; large step outputs belong in artifacts.
- Budgets restart on resume: tokens spent before the crash are in the log totals but not charged against the resumed run's budget. Acceptable for $0 providers; to fix when paid BYOK runs need hard caps across restarts.
- Agent ids restart from `_1` on resume, so lanes in the UI may show the same agent id twice for a re-run step.
