# ADR 0006: Planner, orchestrator and critic as the multi-agent core

- Status: Accepted
- Date: 2026-11-25

## Context

M2 turns single-agent missions into teams: a plan the user can approve or edit, specialist sub-agents running in parallel, replanning when something fails, and a critic that verifies claims before anything is delivered. The default model chain is small and throttled (keyless gpt-oss-20b, about one call per 40 s); the owner chain is fast (Nemotron 3 Ultra, Nemotron Lightning on NVIDIA).

## Decision

- **Planner composes from a step library.** Each mission exposes typed step executors (research, read, analyse lenses, rank, synthesise, critic). The planner model builds the DAG from that library; code rejects unknown steps, wrong roles, extra capabilities, cycles, unmet inputs and missing required steps. When a planner call is projected to be slow, or fails twice, the mission's default plan is used and the reason is recorded in `plan.proposed.rationale`.
- **Human approval is a hook, not a UI concern.** `runMission` accepts `awaitPlanApproval`; reviewer edits become `plan.revised` (source `reviewer`) followed by `plan.approved`. Without the hook (evals, CLI) plans are auto-approved by `system` with a reason.
- **Orchestrator** runs ready steps concurrently with per-step budgets from `budgetShare` (5% floor) and a per-run provider gate that queues calls instead of failing over when a provider's concurrency is exhausted. Sub-agents get isolated context and only their step's capabilities, and return `{summary, findings, sources, confidence, artifacts}`. Replanning is capped at two attempts per run.
- **Critic** checks atomic claims against whole cited quotes with the fast model. Contradicted or uncited claims are removed; `not_enough_info` gets one fix attempt, then is kept as `support: "weak"`. If nothing survives or the critic fails, the draft is delivered marked `unverified` rather than failing the run. Citation accuracy is always reported on the critic step's `step.completed` payload.
- **Genericity and realism guards live in code** for the Automation Audit: opportunities must cite company-specific evidence, generic patterns are rejected, the requested department is enforced, and ROI inputs are capped with stated assumptions.

## Consequences

- Plans are inspectable, editable and replayable from events; quality failures degrade to clearly labelled drafts instead of empty runs.
- On the keyless chain, the extra reader and critic calls make an X-ray slower (about 190 s versus 63 s in M1); the owner chain completes an Audit in about 140 s.
- Known gap: the editor's fix loop can narrow workflow descriptions into plain evidence statements; next step is to check workflows for contradiction only.
