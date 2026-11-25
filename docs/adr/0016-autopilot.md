# ADR 0016: Autopilot, a parent run that carries a goal through child missions

- Status: Accepted
- Date: 2026-11-25
- Builds on: ADR 0005 (event log), ADR 0006 (approvals as hooks), ADR 0007 (durable resume), ADR 0009 (fork and parent links), ADR 0011 (Ship-a-PR approvals), ADR 0014 (workspace automation defaults)

## Context

A custom goal ends in a cited brief with ranked actions and "next action" buttons. The user still has to click through Company X-ray, the Automation Audit and Build it, or Repo X-ray and Ship-a-PR, copying what one run found into the next. We want Delegate to carry the work through: type a goal, get the brief, then the top actions executed as real missions, each with its own plan, approvals, evidence and deliverable, and a final report of what was done and what still needs a person.

Constraints: production is Vercel serverless (300 s per function, no long-lived memory, work scheduled with `after()`), durable resume is driven by the stale-run sweeper from the event log (ADR 0007), the event log is the only source of truth, and every side effect keeps the approval it has today.

## Decision

### 1. A separate `autopilot` mission, not a toggle on custom-goal

Autopilot is its own mission id whose run is a **coordinator**: it calls no model and runs no tools. Its first child is an ordinary `custom-goal` run that produces the brief.

- Custom-goal is a single-invocation mission with a 230 s hard deadline and a research pipeline that is changing under other work. Making it also wait for children would stretch its lifetime past every limit it was designed around and couple orchestration to research code. A coordinator mission keeps both small.
- The brief stays a normal, replayable, forkable custom-goal run with its own page; Autopilot links to it like any other child.
- Depth is enforceable by mission id: children are drawn from a closed enum (`CHILD_MISSION_IDS`) that does not contain `autopilot`, and the API refuses an autopilot request that names a parent. Max depth is 1 by construction.
- The only custom-goal touch point is the `next-actions` artifact it already publishes: Autopilot reads it to choose a track.

### 2. Parent/child model in the event log

- `run.created.payload.autopilot = { parentRunId, nodeId }` on a child (optional, additive; folded into `RunState.autopilot`). The `runs.parent_run_id` column mirrors it for queries.
- `child.started { childRunId, nodeId, missionId, label, input, from?, approvals }` on the parent. `from` names the contract and the artifact (and item) the input was derived from; `approvals` records the plan mode (`auto` | `human`) and side-effect mode (`ask` | `patch_only` | `none`) the child runs under.
- `child.completed { childRunId, nodeId, missionId, outcome, tokens }` with a summarised `ChildOutcome` (status, summary, deliverable reference, up to six metrics, links, what needs a human).
- `foldRun` builds `RunState.children`, rejects a second running child, repeats and unmatched completions. Both are new `RunEvent` types; migration 0009 widens the `run_events_type_known` check (same drop/add pattern as 0005–0007, no table or RLS change).
- A child's live status (planning, waiting for approval) is read from the child's own record; the parent log holds the graph and every final outcome, so the mission graph and the report are rebuildable from events.

### 3. Durable waiting without waiting

The parent never blocks. `advanceAutopilot` is a short, idempotent step under the parent's run lease (ADR 0007's lease column):

1. fold the parent log; if a child is open, read its record: still running → `reviveOrSweep` the child (so the parent is also its children's sweeper) and return; finished → summarise the child's log into `child.completed`;
2. ask the pure planner (`nextAutopilotMove`) for the next move; to start a child it first appends `child.started` with a pre-generated run id, then creates the child row with that id and schedules it; if the process dies between the two, the next advance sees a `child.started` without a row and creates it;
3. to finish, it appends the `autopilot-report` artifact and `run.completed` or `run.failed`.

It is triggered by: the request that created the run (`after()`), the child's own executor when the child settles (`onSettled`, so the next child starts in the invocation that observed the previous one), and any read of the parent (run page render, the SSE idle hook, MCP `get_run` / `wait_for_run`). Autopilot runs are exempt from the generic stale sweep, because their quiet periods are children working. If a next child is scheduled late in an invocation and the function is cut at 300 s, the child is resumed by its own durable path, which the parent's next advance triggers.

### 4. Chaining contracts (`packages/runtime/src/missions/autopilot/chain.ts`)

Every hand-off parses the previous child's deliverable with its zod schema and builds the next input with the next mission's input schema; a failure stops Autopilot with the contract name and the zod issues.

| Contract                        | From                                                  | To                                                                                                                                                         |
| ------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| goal-brief → track              | `goal-brief` + `next-actions`                         | first launchable action decides the track: company (X-ray → Audit → Build it) or repo (Repo X-ray → Ship-a-PR); else the resolved company; else brief only |
| company-xray → automation-audit | X-ray brief's company URL, brief objective            | `AutomationAuditInput { url, focus }`                                                                                                                      |
| audit opportunity → build-agent | top opportunity not marked unverified                 | `BuildAgentInput { url, goal: automation, name, opportunityId, fromAuditRunId }`                                                                           |
| repo improvement → ship-a-pr    | best-ranked verified improvement, preferring effort S | `ShipAPrInput { repoUrl, ref, improvement }`                                                                                                               |

### 5. Safety

- **Each child obeys its own approvals.** Plan approval for a child follows the workspace `auto_approve_plans` setting read when the child starts (Ship-a-PR keeps its fixed plan). Side effects are unchanged: Ship-a-PR always asks before pushing; connector writes ask unless pre-approved exactly as today.
- **Demo visitors** (no GitHub installation and no connectors in the workspace) get read-only children and patches: Ship-a-PR children receive no installation lookup, so the `ship-demo` policy denies `github.open_pr` and the result is a patch; custom-goal children receive no connectors. Connected workspaces get both, still behind approvals.
- **Budgets:** at most 4 children, depth 1, 45 minutes of wall time from the parent's creation, 1.2 M tokens summed over children; each child also keeps its own run budget. Exceeding a cap stops before the next child with a stated reason. A running child that outlives the wall-time cap is cancelled.
- **Stop on first failure:** a failed child ends Autopilot as failed, with the child's error in the report.
- **Quotas:** the parent itself spends no model tokens and does not count; every child takes one unit of the per-guest run quota. An exhausted quota stops Autopilot with that reason.
- **Hand-offs carry no privilege.** The fields passed on (an opportunity's automation text, an improvement's title and acceptance criteria, a URL) were written by models in the previous child. They are re-parsed with the next mission's input schema and become that child's input, exactly what a human click on today's "Build it" / "Ship it" buttons would send; the next child applies its own quarantine, URL guards and approvals to them. Autopilot never widens a child's capabilities.
- Every child start writes a `policy.decided` (`autopilot`) event describing the tier and modes, so the audit view shows why a child could or could not reach a side effect.

### 6. Surfaces

- Run page: a live mission graph (nodes are children with status and links; future nodes of the chosen track shown as queued) and the Autopilot report; each child shows a "Part of Autopilot run …" banner.
- API: `POST /api/runs` accepts `missionId: "autopilot"` with `{ goal, url? }`; `GET /api/runs/:id/children` returns the graph with live child status.
- MCP: `start_autopilot { goal, url? }`; `get_run` includes `children` (and `autopilotParent` on a child).

## Consequences

- Children run one at a time. A company track takes the sum of four missions (about 10–15 minutes on the owner chain); acceptable for a run the user does not watch step by step.
- Progress between children depends on something touching the parent (the child's executor, the page, MCP polling). With every tab closed and the after() chain cut by a crash, the parent waits until it is next read, like every durable run in ADR 0007. A cron hitting the same `advanceAutopilot` would remove that gap; it is a deployment choice.
- The guest run quota is an in-memory limiter per function instance (as for every run); it bounds a single Autopilot but is not a global cap.
- Forking an Autopilot run is refused; fork the child you want to change.
