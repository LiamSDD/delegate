# What Delegate is

Delegate is an agent platform. You give it a company URL, a public GitHub repository or a goal in plain language. It plans the work, runs specialist agents in parallel, checks every claim against its source and returns a finished deliverable: a cited company brief, a ranked automation audit with an explicit ROI model, a working assistant trained on a company's own site, an architecture map of a repository, or a tested code change that waits for your approval.

It is live at https://delegate-beryl.vercel.app, needs no account and costs $0 per run. The fastest way to understand it is to [run a mission](quickstart.md).

## What a run does

Every mission goes through the same stages, and each stage is written to an append-only event log before anything else sees it.

1. **Plan.** The planner composes a plan from the mission's own step library. Each step has a role, an objective, the capabilities it may use and a share of the run's budget. Code rejects unknown steps, extra capabilities, cycles and unmet inputs. You approve or edit the plan, or let it be approved automatically.
2. **Work in parallel.** The orchestrator runs every step whose inputs are ready. Each sub-agent gets an isolated context and only the capabilities of its own step.
3. **Read in quarantine.** Web pages, repository documentation and connector output are read by a model call that has no tools. It returns typed facts with verbatim quotes, and code checks that each quote appears in its source. See [the quarantined reader](quarantined-reader.md).
4. **Check every tool call.** A capability check and the policy engine run before a tool does. Calls with side effects wait for a person. See [policy and approvals](policy-and-approvals.md).
5. **Verify.** The critic checks each claim against the quotes it cites. Claims that stay unsupported are removed, and the deliverable reports its citation accuracy.
6. **Deliver.** The result is a typed artifact on the run page, with every citation one click away from its quoted source.

Because the log is the source of truth, a finished run can be replayed, forked from any finished step and compared with another run. [Reading a run page](reading-a-run.md) shows where each of those lives.

## What you can run today

| Mission | You give it | You get |
|---|---|---|
| Company X-ray | A company URL | A cited brief: offering, customers, market, competitors, positioning, recent news, SWOT and tech-stack signals |
| AI Automation Audit | A company URL, optionally a department | 5 to 8 workflows that agents could automate, ranked by an ROI estimate whose formula and inputs are shown |
| Build it | An audit opportunity | An assistant that answers only from the company's site, with citations, an eval set and a gaps report |
| Repo X-ray | A public GitHub repository | Architecture map, module responsibilities, onboarding guide, hotspots, test gaps and 5 to 8 ranked improvements |
| Ship-a-PR | One Repo X-ray improvement | The change implemented in a sandbox with the repository's tests run before and after, then a pull request or a patch after you approve the diff |
| Custom goal | A goal in plain language | A cited brief with findings, a ranked action plan and risks |
| Autopilot | A goal | The goal brief, then its top actions carried out as follow-up missions |

[Missions](missions.md) gives the inputs, the deliverable and the limits of each one, with the numbers taken from the code.

## Models and cost

The runtime never names a model. It asks for a role (`planner`, `worker` or `fast`), and `config/models.json` maps each role to an ordered chain of providers. When the server has an `NVIDIA_API_KEY`, the chain starts on NVIDIA-hosted open-weight models. With no key at all it falls back to a keyless community endpoint, which is much slower. A rate limit, a timeout or an error moves a call to the next entry, and the move is recorded as a `model.fallback` event, so the run page shows which model served each step. ADR 0003 has the measurements behind the order.

## Why it can be trusted with real work

- Untrusted content never reaches an agent that has tools. It is read in quarantine and comes back as typed facts.
- Security lives in code paths with tests. A prompt that says "do not do X" is not treated as a control.
- Every policy decision, approval and tool call is an event in the log, and the audit view at https://delegate-beryl.vercel.app/control/audit is read from that log.
- The [red-team suite](red-team.md) runs every attack case against the real code paths before each push. A single successful attack fails the gate.
- Quality is [measured with confidence intervals](evals.md), and the scoreboard is built from result files committed to the repository.

The full threat model is in the [security model](../SECURITY.md).

## Use it from your own tools

Delegate is also a remote MCP server. [Connect Claude Code, Codex, Cursor or VS Code](connect-mcp-clients.md) and start missions from your terminal. Runs started that way stream live in the web app and go through the same policies, approvals and quotas. You can also [connect your own MCP servers](connect-mcp-servers.md) so runs can use your tools, and [connect GitHub](github-and-ship-a-pr.md) so Ship-a-PR can open pull requests on repositories you choose.

## Run it yourself

[Run locally](run-locally.md) with `pnpm dev` and an embedded database, or [deploy it on Vercel and Neon](../DEPLOY.md), both on free tiers. [Self-hosting](self-hosting.md) covers the database roles and the environment.

## How it was built

Delegate was built by one engineer directing coding agents inside a harness of written constraints, independent reviews and evals. The [case study](../CASE_STUDY.md) describes the process, and the [decision records](decision-records.md) explain each architectural choice.
