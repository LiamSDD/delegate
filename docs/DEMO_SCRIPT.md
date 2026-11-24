# Demo scripts

Both demos run live, in one take, on targets Delegate has never seen. Pick targets on the day; never rehearse on the recorded target. Fallback only to a recorded run that is visibly labelled "Replay".

## Pre-flight (both demos)

- `/demo-check` passes: deploy healthy, keys valid, quotas reset, evals and red-team green on `main`.
- Browser at 1440×900, dark theme, zoom 100%, notifications off; second window with the terminal for Demo B.
- Budget visible in the top bar; target cost under $1 for Demo A.

## Demo A · 90-second cut (recruiters)

| Time | Screen | Action | What the viewer must notice |
|---|---|---|---|
| 0–8 s | `/` | Paste a company URL, press Enter | One input, no setup |
| 8–25 s | `/runs/[id]` | Plan streams in under 2 s; click Approve | Typed plan DAG; 4 sub-agent lanes start in parallel |
| 25–40 s | Run view centre | Critic flags an unsupported claim (amber) and fixes it; an approval card appears inline | The system checks its own work and asks before risky actions |
| 40–55 s | Run view right | Company X-ray, then AI Automation Audit; drag an ROI slider | Cited, company-specific output; ROI formula visible |
| 55–65 s | `/agents/[id]` | Click "Build it" on the top opportunity; ask the new assistant a question | A working cited assistant built from the company's own site |
| 65–80 s | `/runs/[id]/trace`, `/evals` | Show the waterfall and "$0.xx · m:ss · xx% cache hits"; flash the scoreboard | Real cost, latency and quality numbers |
| 80–90 s | Architecture diagram, live URL | End card | It is real and live |

Voice-over (one line per beat): "Paste a company. Delegate plans the work, runs specialists in parallel, checks every claim, and asks before it acts. Here is their automation audit with an ROI model you can adjust, and here is one of those automations, built and answering questions from their own site. Every run is traced, costed and evaluated. Under a dollar, under three minutes."

## Demo B · 4-minute engineering deep-dive (tech leads)

1. **Claude Code → Delegate over MCP (0:00–0:40).** Terminal: Claude Code with the Delegate MCP server configured; prompt "run a repo-xray on <repo>". The run appears live in the web UI next to it.
2. **Repo X-ray → Ship-a-PR (0:40–1:40).** Architecture map, hotspots, test gaps. Pick one improvement; the Engineer sub-agent works in a sandbox, tests pass, approval card appears; approve; the PR opens on an owned repo.
3. **Live attack (1:40–2:20).** Feed a page with hidden injection instructions. Show the quarantined reader's `injectionSuspected` flag, the policy engine's deny on the triggered tool call, and the entry in the audit log.
4. **Time travel (2:20–3:00).** Open a finished run's trace, "Fork from here" at step 4 with a different model or prompt version; side-by-side diff of output, cost and quality.
5. **Evals (3:00–3:35).** `/evals`: Pareto chart of quality vs cost with confidence intervals; the CI gate on a recent PR.
6. **Self-host (3:35–4:00).** `docker compose up`, set `ANTHROPIC_API_KEY`, open localhost: the same product on your own infrastructure.

Close: "Hand-written runtime, policy on every tool call, a quarantined reader for untrusted content, every run replayable and evaluated. The docs folder has the architecture, threat model and ADRs."
