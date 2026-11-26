# Delegate

**Turns a company's goals into finished, verified work, safely enough for an enterprise to let it run.**

Paste a company URL, a GitHub repo or a goal. Delegate plans the work, runs specialist agents in parallel, verifies every claim against its source, asks before anything risky happens, and records every step so the run can be replayed, forked and evaluated.

<a href="https://github.com/LiamSDD/LiamSDD/blob/main/assets/demos/delegate-demo-1080p60.mp4"><img src="docs/images/demo-loop.gif" alt="Delegate demo: a goal goes in, the plan is approved, agents work in parallel and every claim comes back cited" width="100%"></a>

**[Watch the 60-second demo](https://github.com/LiamSDD/LiamSDD/blob/main/assets/demos/delegate-demo-1080p60.mp4)**: real live runs on the free model chain, with only the waiting sped up.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/home-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/images/home-light.png">
  <img alt="Delegate home page: one input for a company URL, a GitHub repo or a goal, with the live model chain" src="docs/images/home-dark.png" width="100%">
</picture>

**Live demo: [delegate-beryl.vercel.app](https://delegate-beryl.vercel.app)**. Paste a company URL and watch the agents work. Free models, $0, no sign-up.

**Read the case study: [How I built Delegate with Claude Code](docs/CASE_STUDY.md)**.

> **Status: M0–M5 shipped, M6 platform interfaces shipped except Ops Pulse, M7 in progress.** Five missions and Autopilot run live end to end on free NVIDIA-hosted models with a keyless fallback; the sixth, Ship-a-PR, is built and switched off on the public demo. Around them: deep research, agent teams, a quarantined reader, a policy engine on every tool call, fork, replay and run compare from the event log, Mission Control, workspace Settings, a REST API with an SDK, a CLI and signed webhooks, and an MCP server with MCP connectors. A red-team suite runs in the local gate. Latest live X-ray eval: 81% pass (95% CI 57–93%, n=16), p50 62 s, $0. 2,700 tests. Every number on this page comes from code or committed result files in this repo; see [`/evals`](https://delegate-beryl.vercel.app/evals) and [`docs/PROGRESS.md`](docs/PROGRESS.md).

## Why it exists

A demo agent that does impressive things is common. What enterprises actually pay for is the hard part around it:

| | What Delegate does |
|---|---|
| **Value** | Work specific to the company: a cited Company X-ray, an AI Automation Audit with an adjustable ROI model, "Build it", which turns the top opportunity into a working cited assistant, Repo X-ray for codebases, and Autopilot, which carries a goal through several of these missions. |
| **Trust** | Every claim is cited and checked. Untrusted content is read only by a quarantined, tool-less model. Every tool call passes a policy engine; risky actions need approval; everything is audited. |
| **Operability** | Every run is an append-only event log: replayable, forkable from any step, traced with OpenTelemetry, costed, and regression-tested with statistics. Mission Control shows what is running and what waits on a person. |
| **Integration** | MCP server (call it from Claude Code or Codex), REST API v1 with OpenAPI and a TypeScript SDK, a CLI, signed webhooks, MCP client connectors, self-hosting on one machine or on Vercel and Neon, bring-your-own Claude key. |

## What you can delegate

| Mission | Input | Deliverable | On the live demo |
|---|---|---|---|
| Company X-ray | Company URL | Cited brief: offering, customers, market, competitors, positioning, news, SWOT, stack signals | Live |
| AI Automation Audit | Company URL, optional department | 5–8 company-specific workflows to automate, ranked by an explicit, adjustable ROI model | Live |
| Build it | An Audit opportunity | A cited assistant trained on the company's own site, with an eval set, a gaps report and an embeddable widget | Live |
| Repo X-ray | Public GitHub URL | Architecture map, hotspots, test gaps and ranked improvements, cited to `path:line` | Live |
| Ship-a-PR | A Repo X-ray improvement, an authorised repo | The change made and tested in a sandbox; a pull request only after a person approves the exact diff | Built; off on the public demo |
| Custom goal | A goal in plain language | Cited goal brief with findings by workstream, a ranked action plan and risks | Live |
| Autopilot | A goal | The goal brief, then up to three follow-up missions, each with its own plan, approvals and deliverable, and a final report | Live |

## Runs for $0

Delegate needs no paid API and no accounts by default ([ADR 0003](docs/adr/0003-zero-cost-model-routing.md)). Each role (planner, worker, fast) has a fallback chain: keyless hosted open-weight models, then in-browser models on WebGPU, then local models with Ollama. Free-tier keys (Kimi K3, DeepSeek, Groq, Cerebras) and Claude with your own key are optional extras. The router falls back on rate limits, stalls and errors, and every step records which model served it.

## Architecture

```mermaid
flowchart LR
  EN[Web UI · REST API + SDK<br/>CLI · MCP clients] --> G[Goal or mission input]
  G --> AP[Autopilot<br/>optional · child missions]
  AP -. each child is a full run .-> I
  G --> I[Intake<br/>MissionSpec]
  I --> P[Planner<br/>phased step DAG]
  P --> A{Approve / edit}
  A --> O[Orchestrator<br/>parallel sub-agents · teams · budgets · replanning]
  O --> W[Researcher · Analyst · Builder · Engineer]
  W --> DR[Deep research<br/>follow-ups on thin sections]
  DR --> C[Critic<br/>atomic claims · entailment · specificity]
  C --> D[Deliverables<br/>cited · exportable]
  W -. untrusted content .-> Q[Quarantined reader<br/>no tools · schema-checked]
  W -. every tool call .-> PE[Policy engine] -. allow / deny / approval .-> AU[(Audit log)]
  O --> EV[(run_events<br/>append-only)]
  EV -. SSE replay-then-live .-> UI[Run view · Mission Control]
  EV -. finished or needs a decision .-> WH[Signed webhooks]
```

- **Hand-written agent runtime**, no agent framework ([ADR 0001](docs/adr/0001-hand-written-runtime.md)). The loop is about 170 lines and meant to be read in one sitting.
- **Quarantined reader** (dual-LLM pattern) so instructions hidden in a web page have nothing to talk to ([ADR 0002](docs/adr/0002-quarantined-reader.md)).
- **Event log as the single source of truth:** the UI, traces, replay, forks and crash recovery are all rebuilt from typed `RunEvent`s.

Full design: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Threat model: [`docs/SECURITY.md`](docs/SECURITY.md). Decisions: [`docs/adr/`](docs/adr) (20 ADRs).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/trust-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/images/trust-light.png">
  <img alt="How Delegate stays trustworthy: quarantined reader, policy on every tool call, append-only event log, evals with confidence intervals" src="docs/images/trust-dark.png" width="100%">
</picture>

## What is built

### Capabilities

| Capability | What it does | Where |
|---|---|---|
| Missions | Company X-ray, AI Automation Audit, Build it, Repo X-ray, Ship-a-PR and custom goals, each with an input schema, allowed capabilities, a deliverable schema and an eval dataset. | [`packages/runtime/src/missions`](packages/runtime/src/missions), [guide](docs/guides/missions.md) |
| Planner, orchestrator, critic | Validated step DAG with phases, plan approval and editing, parallel sub-agents with per-step budgets, capped replanning, and a critic that checks atomic claims against whole quotes. A revision that widens capabilities always waits for a person. | [ADR 0006](docs/adr/0006-planner-orchestrator-critic.md), [ADR 0015](docs/adr/0015-deep-research-and-specificity.md) |
| Deep research | Bounded follow-up rounds after the first draft on sections with thin evidence; generic background claims are moved to context or dropped, and specificity is reported next to citation accuracy. | [ADR 0015](docs/adr/0015-deep-research-and-specificity.md) |
| Autopilot | A coordinator run that starts a custom goal, then up to three child missions from its ranked actions. Each child keeps its own approvals; depth is one by construction. | [ADR 0016](docs/adr/0016-autopilot.md) |
| Agent teams | A plan step may declare a bounded fan-out of members with their own budgets, a typed run blackboard, a self-check before hand-off, and one typed-output path with repair. | [ADR 0020](docs/adr/0020-agent-teams-and-learned-routing.md) |
| Durable runs, fork, replay, compare | Runs resume from the event log after a crash; any step can be forked; recorded runs replay; two runs diff claim by claim. | [ADR 0007](docs/adr/0007-durable-runs-from-the-event-log.md), [ADR 0009](docs/adr/0009-fork-replay-compare.md) |
| Trust layer | Policy engine on every tool call, SSRF-hardened fetch, quarantined reader, PII redaction in the event emitter, audit log, and a red-team suite that runs in the local gate. | [`docs/SECURITY.md`](docs/SECURITY.md), [guide](docs/guides/red-team.md) |
| Evals and training | Datasets for five missions with committed live results, Wilson and t intervals, Pareto chart and judge calibration on `/evals`; `pnpm evolve` and `pnpm train` promote a prompt or playbook only on a paired, significant win; `pnpm route:learn` derives model order from per-trial evidence. No training round or learned routing file is committed yet. | [`packages/evals`](packages/evals), [ADR 0021](docs/adr/0021-training-loop.md) |
| Evolving playbooks | Typed lessons from each finished run, per workspace and per house, shown to the planner with their scores. | [ADR 0013](docs/adr/0013-evolving-playbooks.md) |
| Mission Control | Approvals inbox across runs, active runs with their current step, usage, and two safety switches: pause new runs (enforced in the database) and stop all runs. | [ADR 0019](docs/adr/0019-mission-control-and-settings.md) |
| Settings | API tokens, MCP connectors and GitHub, webhook endpoints, the policy sets with a dry run, automation defaults, and workspace export and deletion. | [ADR 0019](docs/adr/0019-mission-control-and-settings.md) |
| Platform interfaces | REST API v1 (bearer tokens, idempotency keys, one error envelope, OpenAPI 3.1 at `/api/v1/openapi.json`), a typed SDK, the `delegate` CLI, and HMAC-signed webhooks with retries. | [ADR 0018](docs/adr/0018-platform-interfaces.md), [API](docs/guides/api.md), [CLI](docs/guides/cli.md), [webhooks](docs/guides/webhooks.md) |
| MCP | Remote MCP server at `/api/mcp` for Claude Code, Codex, Cursor and VS Code; MCP client connectors whose output goes through the quarantined reader and whose side-effecting tools ask for approval. | [ADR 0014](docs/adr/0014-connections.md) |
| Docs site | The guides in [`docs/guides`](docs/guides), served at [`/docs`](https://delegate-beryl.vercel.app/docs) with search. | [`apps/web`](apps/web) |

### Packages and tests

| Package | What it does | Tests |
|---|---|---|
| [`packages/runtime`](packages/runtime) | Agent loop, model router with fallback and rotation, adapters, quarantined reader, crawl engine and keyless research tools, missions, planner, orchestrator, critic, deep research, teams, Autopilot, durable resume, sandbox, MCP client, playbooks, PII redaction, OpenTelemetry. | 1,138 |
| [`apps/web`](apps/web) | Next.js app: home, run view with live events, plan approval, lanes, trace, replay, fork and compare; assistants and the embed widget; `/evals`; Mission Control and audit log; Settings; docs site; REST v1 and MCP route handlers. | 811 |
| [`packages/db`](packages/db) | Postgres schema and migrations with FORCE row-level security on every tenant table, a non-owner app role, `SECURITY DEFINER` write paths, append-only event and audit logs, idempotency keys, webhook deliveries, the pause switch and workspace erasure. | 257 |
| [`packages/evals`](packages/evals) | Eval harness, datasets, graders and judge, statistics, red-team suite, `evolve`, `train` and `route:learn`. | 195 |
| [`packages/sdk`](packages/sdk) | The v1 contract as zod schemas, OpenAPI generation, the typed client with SSE, and webhook verification. | 95 |
| [`packages/policy`](packages/policy) | Declarative policy engine that fails closed: side effects need approval, egress needs an allowlisted target, private and metadata hosts are blocked. | 83 |
| [`scripts`](scripts) | Secret scanner (pre-commit) and git hooks. | 79 |
| [`packages/cli`](packages/cli) | `delegate login`, `run --watch`, `runs`, plan decisions and artifacts. | 34 |
| [`packages/mcp-server`](packages/mcp-server) | MCP tools and resources over the REST backend, for HTTP and stdio. | 8 |
| **Total** | | **2,700** |

Counted on `main` with `vitest run` in each package and `vitest run --dir scripts` at the root; `pnpm check` runs the same suites before every push.

## Roadmap

| Milestone | Scope | Status |
|---|---|---|
| M0 · Foundation | Monorepo, data model with RLS, events, router, policy, evals stats, design system | Done |
| M1 · Runtime + Company X-ray | Streaming tool-use loop, quarantined reader, run view on live events, first eval dataset | Done |
| M2 · Multi-agent + Automation Audit | Planner DAG, parallel lanes, critic, interactive ROI model, trace waterfall | Done; the five-company exit check is not recorded yet |
| M3 · Build it + durability | Build-an-Agent (crawler, hybrid RAG, widget), durable runs, approvals | Done; the Demo A exit check is not recorded yet |
| M4 · Trust layer | Red-team suite, replay, fork-from-step, `/evals` scoreboard | Done |
| M5 · Engineering missions | Repo X-ray, Ship-a-PR in a sandbox | Done; Ship-a-PR has not opened a live pull request yet |
| M6 · Platform interfaces | REST API, SDK, webhooks, CLI, MCP server and connectors, Ops Pulse | Shipped except Ops Pulse |
| M7 · Enterprise | RBAC + SSO, policy editor, Mission Control, standing missions, self-hosting | In progress: Mission Control, Settings with a policy dry run, BYOK Claude and member roles in row-level security are in; SSO, policy editing, standing missions and Bedrock/Vertex are not |
| M8 · Launch polish | Load test, accessibility audit, demo videos | Planned |

Shipped beyond the original plan: Autopilot, deep research, agent teams, evolving playbooks and the training loop. Next: Studio, which takes an idea to a working product.

The full spec, including both demo scripts, is in [`SPEC.md`](SPEC.md) and [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md).

## Built with Claude Code

This repo is developed with Claude Code as a disciplined engineering team, and the workflow is part of the project. The [case study](docs/CASE_STUDY.md) describes how.

- [`CLAUDE.md`](CLAUDE.md): the working agreement every session reads (rules with their reasons, definition of done, model facts).
- [`.claude/commands/`](.claude/commands): `next-task`, `verify`, `eval`, `redteam`, `demo-check`, `adr`.
- [`.claude/agents/`](.claude/agents): `code-reviewer`, `security-reviewer`, `eval-analyst`, `ux-critic`.
- Hooks: lint on every edited file, secret scan before every commit, full check before every push.
- Independent workstreams run as parallel sub-agents, each scoped to its own packages, then reviewed before merge.

## Connect from Claude Code / Codex

Delegate is a remote MCP server at `https://<host>/api/mcp` (Streamable HTTP). Create a workspace API token under **Settings → Connections**, which also shows ready-to-paste setup for Cursor, VS Code and any MCP client.

```bash
# Claude Code
claude mcp add --transport http delegate https://<host>/api/mcp \
  --header "Authorization: Bearer <your-delegate-token>"
```

```toml
# Codex: ~/.codex/config.toml, with DELEGATE_TOKEN exported in your shell
[mcp_servers.delegate]
url = "https://<host>/api/mcp"
bearer_token_env_var = "DELEGATE_TOKEN"
```

Then ask your agent to "run a company X-ray on acme.com with Delegate". The tools are `start_mission`, `get_run`, `wait_for_run`, `approve_plan`, `reject_plan`, `list_runs` and `get_artifact`; deliverables are also resources (`delegate://runs/{runId}/deliverable`). Runs started over MCP stream live in the web UI and go through the same policies, approvals, quotas and audit log. For stdio-only clients: `DELEGATE_URL=https://<host> DELEGATE_TOKEN=<token> pnpm --filter @delegate/mcp-server stdio`.

The same page connects your own MCP servers (tools are listed on connect; side-effecting tools ask for approval unless you pre-approve them) and your GitHub repositories. Design and threat model: [ADR 0014](docs/adr/0014-connections.md).

## Use it from a terminal or your code

The same token works for the REST API, the SDK and the CLI ([API guide](docs/guides/api.md), [CLI guide](docs/guides/cli.md)):

```bash
pnpm delegate login --api-url https://<host>
pnpm delegate run repo-xray https://github.com/vercel/next.js --watch
```

```ts
import { createDelegateClient } from "@delegate/sdk";

const delegate = createDelegateClient({ baseUrl: process.env.DELEGATE_URL ?? "", token: process.env.DELEGATE_TOKEN ?? "" });
const run = await delegate.runs.create({ missionId: "company-xray", input: { url: "https://acme.com" } });
```

Webhook endpoints are added under **Settings → Webhooks**; each delivery is signed with HMAC-SHA256 and verified with `verifyWebhook` from `@delegate/sdk/webhooks` ([guide](docs/guides/webhooks.md)).

## Run it locally

```bash
pnpm install
pnpm dev          # web app on http://localhost:3000
pnpm check        # typecheck, lint, test and build across the monorepo
```

Requires Node 26 and pnpm 12. No keys are needed. See [`.env.example`](.env.example) for optional providers and [self-hosting](docs/guides/self-hosting.md) for production setups.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the checks and how to propose a change. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

## License

MIT
