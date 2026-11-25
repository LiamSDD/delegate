# ADR 0019: Mission Control and Settings

- Status: Accepted
- Date: 2026-11-25
- Builds on: ADR 0005 (event log), ADR 0007 (durable runs), ADR 0011 (ship approvals), ADR 0014 (API tokens, connectors, tool approvals, automation defaults), ADR 0016 (Autopilot)
- Replaces: the `/control` and `/settings` placeholders

## Context

An operator has to open each run to see what is active, clear an approval or stop work. There is no way to hold new work for a workspace, no view of what the policy engine would decide, and no way for a visitor to take their data or remove it. Approvals already exist in three kinds (plan, ship, connector tool call), each with its own endpoint and its own rule about what the human must have seen.

Constraints: Vercel Hobby (300 s per invocation, no long-lived memory, streamed responses are the only ones allowed past 4.5 MB), Neon with `FORCE` row-level security on every table and a migration owner that is not a superuser, anonymous guests identified by a signed cookie, `run_events` and `audit_log` append-only by trigger, and everything $0 (ADR 0003).

## Decision

### 1. `/control` is a read-only, set-based view that refreshes itself

The page is a server component. A small client component calls `router.refresh()` every 10 s while the tab is visible; client state (an open reject form, a typed reason) survives the refresh. Rendering runs a fixed number of queries whatever the number of runs: active runs and the children of active Autopilot parents with their latest event and current step come from one statement with lateral top-1 lookups on `(run_id, seq)`; pending approvals from one statement on `approvals_workspace_status_idx`; usage from aggregates. Every query goes through `withTenant`.

Rendering never resumes, sweeps or advances a run. A run with no events for longer than the stale threshold is marked as stalled and links to its run page, which already revives or sweeps it (ADR 0007).

### 2. The approvals inbox calls the existing endpoints and never approves blind

The inbox reads `approvals` rows that are `pending` and belong to a run that has not finished, newest row per run and request, and posts decisions to the three existing routes. It adds no endpoint and no rule. What the reviewer sees is bound to what is approved:

| Kind | Shown in the inbox | Approve | Reject |
|---|---|---|---|
| Plan | every step: objective, role, capabilities, inputs, budget share | sends the steps that were shown (`{ decision, steps }`); the plan route records a plain approval when they still match the pending plan, refuses them when they no longer fit it, and otherwise approves exactly the steps reviewed | existing route |
| Connector tool call | the full canonical arguments and their SHA-256 | sends `argsSha256` exactly as the run page does; changed arguments get 409 | existing route |
| Ship | repository, branch, mode, diff statistics, tests before and after | **not offered**: ADR 0011 requires the human to approve the exact diff, which only the run page shows, so the inbox links there | existing route |

Each item shows the time left, computed from `requested_at` and the timeout constant of its kind. An item past its deadline offers no decision, only the link.

### 3. Pausing new runs is enforced in the database

`workspace_settings.runs_paused_at` (null means running). A `BEFORE INSERT` trigger on `runs` raises SQLSTATE `DG001` while it is set, so no path that creates a run can skip it. One shared check (`server/control/pause.ts`) gives the entry points a clear early error before any quota is taken: `startRunForSession` (web, bearer API, MCP, Autopilot parents), the fork route and the Ship-a-PR route answer `409 runs_paused`; Autopilot stops before the next child with that reason in its report, as it does for an exhausted quota. Running work is not touched. "Stop all active runs" appends the same `run.failed / cancelled` event as the cancel route to every active run and aborts the ones executing in this instance. Both switches write an `audit_log` row before they act (`workspace.runs_paused`, `workspace.runs_resumed`, `workspace.runs_stopped`) and need an owner or admin through the existing RLS policies.

### 4. Usage shows only what the log holds

Every figure carries its unit and window. Runs in the last 60 minutes are shown against `GUEST_RUNS_PER_HOUR`; tokens by mission, model fallbacks, sandbox command seconds and crawled pages cover the last 7 days (the retention window) and are summed from events the run recorded itself, so events seeded into a fork are not counted twice. Sandbox time is the wall-clock duration of `sandbox.command` events, shown next to `VERCEL_SANDBOX_HOBBY`, the allowance Vercel publishes (5 hours of Active CPU a month, source and check date in the constant). The two are different measures and the page says so. Migration 0012 adds `run_events (workspace_id, type, created_at)`; these aggregates and the existing audit listing filter on exactly those columns.

### 5. Settings

- **Overview**: workspace id, tier (guest or connected, the same test Autopilot uses), creation date, and the retention period read from `workspaces.retention_days`.
- **Policies**: the policy sets a run in this workspace gets, per mission and per way of starting it, built from `@delegate/policy` with the workspace's connector hosts. The selection mirrors `policiesFor` in `packages/runtime/src/server.ts`, which is not exported; a test pins that function's source so a change there fails here. The dry-run simulator resolves the request to a tool, capability, host, caller and provider, then calls the real `evaluateAll` and `evaluate`. No model is called and nothing is written.
- **Data**: export and delete (below).
- **Automation**: the existing defaults (auto-approve plans, pre-approved connector tools) on their own page, using the existing route.

### 6. Export

`POST /settings/data/export` (same origin, cookie session) streams one JSON document: workspace, settings, connections without secrets, then each run newest first with its artifacts and its events, read a page at a time. It stops at 32 MiB or 240 s; the document then ends with a `truncated` object naming the reason and the runs left out, and always ends with `"complete": true` so a cut stream is detectable. The request is audited before the first byte.

### 7. Delete

`delete_workspace_data(uuid)` is a `SECURITY DEFINER` function owned by `delegate_definer`, callable through the app connection. It requires the caller (`app.user_id`) to be a human owner of that workspace, writes the `workspace.data_deleted` audit row with row counts first, then deletes the workspace's earlier audit rows, runs (events, artifacts, approvals and run-scoped rows go by cascade), assistants, documents, memories, workspace playbooks, policies, connectors, GitHub installations, API tokens and settings. Every statement is filtered by the workspace id and runs under `FORCE` RLS through explicit `*_definer_*` policies. The append-only trigger lets these deletes through only inside this function, with the same call-stack test the retention purge uses. The route stops active runs first, calls the function, drops the workspace's assistants from this instance's memory, and expires the session cookie. The workspace, its owner membership and the one audit row remain; the row expires with demo retention.

A parity test lists every table with a `workspace_id` column and fails when one is neither deleted by the function nor named as kept, so a table added later cannot be forgotten.

## Alternatives considered

- **Check the pause flag only in application code.** One missed path would ignore the switch. The trigger costs one indexed lookup per run insert.
- **An inbox endpoint that decides any approval.** It would duplicate three guards and could drift from them. Calling the existing routes keeps one rule per kind.
- **Approve ship requests from the inbox with the diff summary.** That is approving a diff nobody read.
- **Delete the workspace row and rely on cascades.** It would also remove the audit row that records the deletion, and the append-only triggers refuse it by design.
- **Live updates over SSE for `/control`.** A second stream per tab on a 300 s function for data that changes every few seconds; a 10 s refresh is enough for an operator view.

## Consequences

- A table that gains a `workspace_id` after this migration must be added to `delete_workspace_data` or to the kept list; the parity test says which.
- The inbox can show a plan up to 10 s old. Approving sends the reviewed steps, so a newer plan is never approved unseen.
- Sandbox seconds are not Active CPU; the page cannot say how much of the Vercel allowance is left, only how much command time this workspace logged.
- Assistants and their crawled text also live in per-instance memory. Deleting evicts them from the instance that served the request; another warm instance keeps its copy until it is recycled. Closing that needs the public chat route to check the database, which is outside this change.
- After deletion the old cookie, if replayed, reaches an empty workspace. Guest sessions have no server-side revocation today.
- Migration 0012 was written beside 0010 and 0011. Journal `when` values must stay increasing in journal order, or drizzle skips the later file on a database that already applied an earlier one.
