# Reading a run page

A run page at `/runs/<id>` is rebuilt entirely from the run's event log. The browser receives the events as a stream and folds them into the view. Reloading the page, or opening it a week later, gives the same picture, because nothing on it is stored anywhere else.

## The top bar

The first line names the mission and its target, with the run's status. Two labels can appear next to it:

- **Simulated · no research, no model calls** marks a run from the scripted development runner. It cannot appear in production.
- **Replay** marks a recorded run being played back.

Below it are the run's numbers:

| Metric | Meaning |
|---|---|
| Elapsed | Wall-clock time from the run's creation to its terminal event, or to now. |
| Steps | Steps done out of steps planned. |
| Tokens in / out / cached | Summed over every model call in the run. |
| Cost | The run's spend. Free providers show as free tier. |
| Cache hit | The share of input tokens served from a provider's cache. `n/a` when no provider reported cached tokens. It is never estimated. |
| Lanes | The number of sub-agents, and how many are live. |
| Citation accuracy | Reported by the critic once it has checked the claims. |
| Models | The models that actually served the run. A model reached after a fallback is marked. |

**Stop** cancels a run that is still working. **Trace**, **Replay** and **Fork** are described below.

## Plan

The plan panel lists the steps with their objective, role, status, duration and share of the budget. When a plan has been revised, a version selector shows each version, so you can see what the reviewer or a replan changed.

If the run is waiting for you, an approval card sits above the panel. You can edit objectives, turn steps off, reorder steps within their dependencies and rebalance the budget, then approve or reject. Capabilities and roles are not editable. A plan left undecided for 10 minutes is rejected.

A later revision that only works within the capabilities you approved proceeds without asking. One that adds a capability, or gives a side-effecting capability to a step that did not have it, comes back for approval, and automatic approval does not cover it.

## Agents

Each sub-agent has its own lane with what it did, in order: its messages, tool calls, policy decisions, critic flags, model fallbacks and approvals. Lanes are how you see parallel work: several can be live at once.

Approval cards for other decisions appear on the page when they are needed: a connector tool with side effects, or a Ship-a-PR diff.

## The deliverable and its citations

The third panel is the deliverable, written section by section as the editor produces it.

- Each claim ends with numbered citation chips. Select a chip to see the source's title and host and the exact quoted span that supports the claim.
- A red chip means the cited source is missing from the sources list, so that citation cannot be verified.
- A section the evidence could not support shows **Insufficient evidence** with a note. A section the run never reached says **Not covered in this run**.
- The sources list at the end links every source the deliverable cites.
- X-ray briefs, audits and goal briefs can be copied as Markdown.

A deliverable marked **Partial result** was published when a mission's deadline arrived before every step had run. One the critic could not verify is delivered as an unverified draft. Both are labelled so that neither is mistaken for a verified result.

## Summary and banners

Between the top bar and the panels:

- **What Delegate did** summarises the run in one row: citation accuracy, duration, agents, sources, cost and models.
- A fork banner appears on a run that was forked from another.
- **Resumed after restart** appears when the run was picked up again from its log, with the reason and the time.
- A chip reading `playbook.applied` shows the guidance the planner received from earlier runs, exactly as recorded in the log.

## Replay

**Replay** is available once a run has finished. It plays the recorded log back through the same code that builds the live view, so what you watch is what was recorded.

- Nothing is re-run and no model is called. No request is made at all.
- Play, pause and restart, at 1×, 2×, 4×, 8× or 16×. Long gaps between events are shortened so a slow tool call does not stall the playback.
- The scrubber moves to any position in the log, with markers at the notable events.

## Fork

**Fork** re-runs a finished run from a step you choose, as a new run.

1. Pick a step that finished.
2. Optionally edit its objective, up to 2,000 characters. The edit is recorded in the fork's log as a plan revision.
3. Choose **Fork from** that step.

Events before the chosen step are copied from the parent's log, so the earlier steps are reused where the mission can restore them. The chosen step and everything after it run again. The parent run is not changed.

The fork's banner states what happened: how many events were copied, which steps were reused, which ran again, and the time to the first new event. It links to the parent and to **Compare with parent**.

## Compare

`/runs/compare?a=<run>&b=<run>` puts two runs side by side: outcome, duration, steps, tokens, citation accuracy, sources and models. Under the numbers is a claim diff of the two deliverables. Within a section, claims with identical text are the same, the closest remaining pair is "changed", and the rest are added or removed. The match is lexical, so a paraphrase shows as one removal and one addition.

## Trace

`/runs/<id>/trace` shows the same log as a waterfall of spans: the run, its steps, each agent, every model call, tool call, policy decision and critic check, with their timing and status. Select a span to see its recorded input and output summaries.

## Why the log is trusted

Every event is validated and written to `run_events` before it is published. The table is append-only: the application role has no `UPDATE` or `DELETE` on it. ADR 0005 covers the stream, ADR 0007 resume and ADR 0009 fork, replay and compare.
