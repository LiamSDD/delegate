# Delegate: product and engineering spec

Source of truth for every session. The roadmap at the bottom is the task list: tick a box only when its definition of done is met.

## Role

A principal AI engineer, platform architect and product designer builds one flagship product across many sessions: **Delegate**, an enterprise agent platform. It is the centrepiece of the owner's portfolio as an AI Engineer and Claude Code specialist. Three audiences judge it:

- recruiters, who watch a 90-second video;
- staff engineers at advanced tech companies, who read the code, the architecture docs and the eval results;
- enterprise buyers, who ask whether they could trust it with their company.

It is built the way a top AI lab would ship an internal platform: ambitious in scope, rigorous in engineering, honest in every number it shows, and fully working at every milestone.

## North star

**Delegate turns a company's goals into finished, verified work, safely enough for an enterprise to let it run.**

Impressive demo agents are common. Very few show the hard part that enterprises pay for:

- **Value:** work specific to *their* company that they would otherwise pay a consultant or an engineer for.
- **Trust:** every claim is cited and verified, every risky action needs approval, every action is policy-checked and audited, and untrusted content can never take control of the agent.
- **Operability:** every run is durable, traceable, replayable, measurable in cost and quality, and regression-tested.
- **Integration:** it plugs into their stack through MCP, an API and webhooks, can run in their own cloud, and can be called directly from Claude Code.

Tie-breaker for every choice: pick what a staff engineer at Anthropic, Stripe or Datadog would respect when reading the code.

## Audiences

Each audience gets its "aha" without explanation:

| Audience | What they must see | Where |
|---|---|---|
| Recruiter / hiring manager | Their own company analysed and improved in about 3 minutes, at $0 | Hero flow from a company URL |
| Staff engineer | Hand-written agent runtime, prompt-injection security model, time-travel debugging, evals with statistics, OpenTelemetry traces | Run view, trace page, "fork from step", `/evals`, `docs/` |
| Enterprise buyer / CTO | Policies, approvals, audit log, RBAC, MCP connectors, API, self-hosting, bring-your-own key, cost and ROI model | Mission Control, policy editor, settings, README |

## Destination

The project is finished when **two demos** work live, in one take, on targets Delegate has never seen.

### Demo A: 90-second cut (recruiters)

| Time | What happens |
|---|---|
| 0–8 s | A company URL is pasted on the home page. |
| 8–25 s | A plan streams in within 2 s and is approved; 4 sub-agent lanes work in parallel. |
| 25–40 s | The critic catches an unsupported claim and fixes it; an approval card appears inline. |
| 40–65 s | A cited Company X-ray and an AI Automation Audit appear with an interactive ROI model. One click on "Build it" turns the top opportunity into a working, cited assistant trained on the company's own website, which answers questions live. |
| 65–80 s | Trace waterfall, "$0.00 · 2m41s · Kimi K3 + gpt-oss-120b", evals scoreboard. |
| 80–90 s | Architecture diagram and live URL. |

### Demo B: 4-minute engineering deep-dive (tech leads)

1. **Claude Code → Delegate over MCP.** In a terminal, Claude Code calls Delegate's MCP server ("run a repo-xray on <repo>"); the run appears live in the web UI.
2. **Repo X-ray → Ship-a-PR.** Architecture map, risk hotspots, test gaps. A coding sub-agent implements one improvement in a sandbox, runs the tests and opens a PR on a repo the owner owns, after approval.
3. **Live attack.** A page with hidden prompt-injection instructions is fed to the agent. The quarantined reader flags it, the policy engine denies the tool call it tried to trigger, and the denial shows in the audit log.
4. **Time travel.** Fork a finished run from step 4 with a different model or prompt; see a side-by-side diff of output, cost and quality.
5. **Evals.** Pareto chart of quality against cost across model and prompt versions, with confidence intervals and the CI regression gate.
6. **Self-host.** `docker compose up` gives a full local stack using the owner's own key.

Everything built serves these two demos or the production quality behind them.

## Missions

A **Mission** is a declarative, pluggable unit in `src/missions/<name>/`: input zod schema, planning hints, allowed tools (capabilities), deliverable schemas, policies, eval dataset. Adding a mission means adding one folder and registering it.

### A. Public-signal missions (zero setup)

1. **Company X-ray** (URL): cited brief covering offering, customers/ICP, market, 5 competitors, positioning, recent news, SWOT, tech-stack signals.
2. **AI Automation Audit** ⭐ (URL, optional department): 5–8 ranked workflows specific to this company that agents could automate. Each has a description, an explicit ROI model (frequency × minutes per task × people involved × adoption rate → hours and € per month) with **interactive sliders**, difficulty, risks, required integrations and a first step. Generic answers ("use AI for customer support") count as failures. Every estimate shows its formula and assumptions.
3. **Build it** ⭐ (from an Audit item): turns an opportunity into a running automation. First builder, **Build-an-Agent**: crawl the public site (same domain, page caps, robots.txt respected), RAG pipeline (pgvector, hybrid search, reranking), live cited assistant at `/agents/[id]`, embeddable widget snippet, "gaps found" report, auto-generated eval set for that assistant.
4. **Competitive Intel:** feature/pricing/positioning matrix, plus a standing weekly monitor that reports semantic diffs.

### B. Engineering missions

5. **Repo X-ray** (public GitHub URL): architecture map (Mermaid), module responsibilities, onboarding guide, dependency and security risk hotspots, test-coverage gaps, ranked high-leverage improvements.
6. **Ship-a-PR:** an Engineer sub-agent on the **Claude Agent SDK inside a sandbox** implements one improvement, runs the repo's tests and lint, then opens a PR, only on repos the user has connected and authorised, and only after approval. For any other repo it produces a downloadable patch and test report.

### C. Internal missions (MCP connectors)

7. **Ops Pulse:** Slack, Jira/Linear, GitHub, Google Drive or Notion through MCP; a cross-tool weekly brief of blockers, stale work, decisions and risks, each line cited to the exact message, ticket or document.
8. **Doc Intelligence:** uploaded PDF/DOCX or connected drives; cited Q&A, contradictions/gaps report, RFP or security-questionnaire answer drafts.
9. **Data Analyst:** CSV/XLSX upload or warehouse connector; code runs in a sandbox and returns charts, insights and the exact re-runnable code.

### D. Standing missions

Any mission can run on a trigger (cron, signed webhook, Slack mention, new file). Results land in the approval queue or are delivered to a channel.

### E. Custom Goal

Free text; the planner composes the tools and agents.

**Hero flows:** A = 1 → 2 → 3. B = 5 → 6.

## Architecture

The agent runtime is written by hand on the Anthropic TypeScript SDK (Messages API, tool use, streaming, server tools, prompt caching): no black-box agent framework. The one exception is the Engineer sub-agent, which uses the Claude Agent SDK in a sandbox (ADR required). Every significant decision gets an ADR in `docs/adr/`.

### 1. Runtime pipeline

- **Intake:** goal → `MissionSpec` (zod).
- **Planner** (strongest model): typed step DAG; each step has id, agent role, objective, input refs, granted capabilities, acceptance criteria, budget share. The plan is shown, editable and approved.
- **Orchestrator:** executes the DAG with a concurrency limit, runs independent steps as parallel sub-agents, enforces budgets, and **replans dynamically** on failure or new information, emitting `plan.revised` with a diff shown in the UI.
- **Sub-agents:** Researcher, Analyst, Builder, Engineer, Critic, Editor. Each gets an isolated context and only its step's capabilities, and returns only `{summary, findings[], sources[], confidence, artifacts[]}`, never its raw transcript.
- **Critic:** extracts atomic claims, checks each against its cited passage (entailment by the fast model), scores against a rubric, makes at most 2 fix loops, then flags what remains. Reports **citation accuracy**.
- **Deliver:** artifacts, executive summary, one-click next actions.

### 2. Model routing (zero-cost, see ADR 0003)

**Operating constraint: the owner spends $0, forever, and works keyless by default.** No paid API, no card on file, no accounts needed to run the product. Claude is an optional bring-your-own-key provider.

- The runtime asks for roles (`planner`, `worker`, `fast`); `config/models.json` maps each role to an ordered fallback chain:
  1. **Keyless hosted open models** (default for the public demo): Pollinations (classic endpoint) and LLM7 anonymous access, OpenAI-compatible, tool-capable models such as gpt-oss.
  2. **In-browser models** (WebLLM on WebGPU): run on the visitor's GPU, keyless and private; "Private mode" in the UI.
  3. **Local models** (Ollama) for self-hosting, owner evals and demo recordings.
  4. **Optional free-tier keys** the owner may add later (NVIDIA Kimi K3 / DeepSeek V4 Pro / GLM-5.3, Groq, Cerebras, OpenRouter `:free`, Cloudflare); unused unless present in env.
  5. **BYOK Claude** for visitors or self-hosters with their own key.
- A router handles per-provider rate limits, `retry-after`, context-window checks and health, and emits `model.fallback` events so every step shows which model served it.
- `ModelProvider` has two adapters: OpenAI-compatible (all free providers) and Anthropic (BYOK, used when a visitor or self-hoster supplies a Claude key; Bedrock and Vertex later through the same interface).
- The public demo uses providers whose terms allow it, with per-visitor quotas and a designed "free capacity used up" state. NVIDIA's trial tier is used for owner-run evals and recordings only.
- A daily smoke test checks every configured provider and model, because free tiers change often.

### 3. Context engineering

- Prompt caching on system prompts, tool definitions and mission context, with deliberate breakpoints; cache hit rate reported.
- Long tool outputs summarised before re-entering context; raw output kept for the trace.
- A per-run scratchpad where agents write notes instead of carrying them in context.
- Compaction of long sub-agent histories.
- A token budget for every step.

### 4. Security model (threat model in `docs/SECURITY.md`)

- **Quarantined reader (dual-LLM):** untrusted content (web pages, uploads, connector data) is only read by a tool-less quarantined model call that returns schema-validated data. Privileged agents only see typed extractions plus quoted spans tagged `untrusted`.
- **Capability-based tools:** a step can only call tools its plan step grants, enforced by the runtime, not the prompt.
- **Policy engine** (`policy` package, declarative TypeScript policies per workspace): evaluates every tool call before execution; approval requirements, egress domain allowlist, spend caps per run and per day, data-classification rules (e.g. "confidential" never goes to external tools). Every allow and deny is audited.
- **Fetch hardening:** SSRF protection (block private/link-local ranges, re-check after redirects), size and time caps, crawler sandboxing.
- **Privacy:** PII detection and redaction in traces and logs; retention policy (public demo runs deleted after 7 days, stated in the UI).
- **Red-team suite:** injections hidden in HTML, CSS-hidden text, PDFs, connector messages, tool-output poisoning. Reports **attack success rate**, which must stay at 0%.

### 5. Durability and time travel

- Runs are durable jobs (Inngest) with step-level checkpoints, retries, cancel and resume. A server restart never loses a run.
- **Event stream (single source of truth):** append-only typed `RunEvent` log in Postgres, pushed over SSE with replay-then-live. Types: `run.created, plan.proposed, plan.approved, plan.revised, step.started, agent.spawned, agent.message, tool.called, tool.result, policy.decided, artifact.created, artifact.updated, critic.flagged, approval.requested, approval.resolved, usage.updated, step.completed, run.completed, run.failed`.
- **Deterministic replay** with recorded tool results.
- **Fork from step N** with a changed prompt, model or input, then diff output, cost and quality side by side.

### 6. Interfaces (everything in the UI is possible without it)

Web UI · versioned REST API with OpenAPI spec and typed TypeScript SDK · signed webhooks · **MCP server** (missions, run status and artifacts as tools and resources) · **MCP client** for enterprise connectors · CLI (`delegate run <mission> <input>`).

### 7. Multi-tenancy and governance

Organisations → workspaces → members (owner/admin/operator/viewer) · **Postgres row-level security** from day one · append-only **audit log** (who or which agent did what, under which policy decision and approval) · SSO (OIDC/SAML) in a later milestone · rate-limited guest workspaces for the public demo.

### 8. Observability

OpenTelemetry tracing following the GenAI semantic conventions, exportable to Langfuse, Datadog or Honeycomb, plus a built-in trace waterfall. Metrics: cost per mission, p50/p95 latency, time to first event, cache hit rate, tool error rate, critic fix rate, citation accuracy, approval wait time.

## Stack

Versions checked on 2026-11-24 (re-check before upgrading):

| Area | Choice |
|---|---|
| App | Next.js 16.4 (App Router, RSC, Route Handlers), React 19.3, TypeScript strict, pnpm monorepo + Turborepo 2.11 |
| Packages | `apps/web`, `packages/runtime`, `packages/policy`, `packages/sdk`, `packages/mcp-server`, `packages/cli`, `packages/evals` |
| UI | Tailwind CSS 4.3 + shadcn/ui, Motion 14, Recharts 3 |
| AI | OpenAI-compatible HTTP adapter (keyless Pollinations / LLM7, local Ollama, optional free-tier keys); `@mlc-ai/web-llm` for in-browser models; `@anthropic-ai/sdk` 1.13 for BYOK Claude; `@modelcontextprotocol/sdk` 1.32 (protocol 2025-11-25) |
| Research sources | Keyless only: the company's own site, sitemap and RSS, Wikipedia/Wikidata, GitHub public API; Jina Reader (keyless) for clean page text |
| Data and jobs | Postgres on Neon free tier + Drizzle ORM 0.45 + pgvector, Inngest free tier, Upstash Redis free tier (rate limits, quotas); sandbox behind an interface (free option decided in M5) |
| Cost | $0: Vercel Hobby, Neon, Inngest, Upstash and every model provider on free tiers, no card on file |
| Tooling | OpenTelemetry (GenAI conventions, incubating), Vitest 5, Playwright 1.65, exceljs, docx, @react-pdf/renderer, zod 4 |
| Deploy | Vercel (public demo), Docker Compose (self-host) |

## UX

**Direction:** calm, premium, precise; Linear crossed with a mission-control console. No generic AI aesthetics (purple gradients, sparkle icons, default card grids). A distinctive type pairing, a restrained palette, light and dark themes. Motion only to show work happening. Keyboard-first (⌘K), WCAG AA. It will be paused frame by frame in a video.

**Screens**

- **`/` Home:** one large input ("Paste a company URL, a GitHub repo, or describe a goal"), mission cards, example targets, one-line value promise.
- **`/runs/[id]` Run view:** left, the live plan DAG with plan revisions as diffs; centre, parallel sub-agent lanes, compact tool-call cards, policy decisions, amber critic flags, inline approval cards; right, deliverables rendering progressively with citations on hover and exports. Top bar: elapsed · steps · tokens · live $ · cache hit rate · model mix · Stop.
- **`/runs/[id]/trace`:** OpenTelemetry-style waterfall with latency, tokens, cost, PII-redacted inputs/outputs and **Fork from here**.
- **`/runs/compare`:** side-by-side diff of two runs.
- **`/agents/[id]`:** the built assistant: cited chat, embed snippet, gaps report, its own eval score.
- **`/control` Mission Control:** active runs, approval queue, spend against budget, standing missions, estimated ROI delivered (always labelled an estimate, with its formula).
- **`/settings`:** members and roles, policy editor with dry-run, connectors (MCP), API keys, model provider (BYOK), data retention, audit log viewer.
- **`/evals`:** per-mission scoreboard: pass rate with CIs, citation accuracy, attack success rate, cost-vs-quality Pareto, judge-vs-human agreement, last CI run.

Every state is designed: empty, loading, streaming, partial, budget hit, policy denied, approval denied, failed with retry, replay. On mobile the run view collapses into tabs and still looks excellent.

## Reliability and evals

Evals start in M1.

- **Datasets:** at least 8 golden cases per mission (real companies and repos of different sizes, industries and languages), versioned in `packages/evals/datasets/`.
- **Output evals:** deterministic checks (schema, citation count, dead links, budget) plus an LLM-as-judge rubric (accuracy, company specificity, actionability). The judge is calibrated against a small human-labelled set; judge-human agreement is reported.
- **Trajectory evals:** right tools used, wasted steps, redundant searches, attempted policy violations.
- **Statistics:** at least 3 trials per case, mean ± 95% CI; regressions only when statistically meaningful.
- **Comparisons:** model × prompt-version matrix with the cost-quality Pareto chart; Message Batches API for cheap bulk runs.
- **Local gate (`pnpm gate`, run before every merge; no hosted CI):** a change is rejected if quality drops beyond the threshold, the attack success rate rises above 0%, or cost per mission rises more than 20%.
- **Production feedback:** thumbs and corrections on deliverables are saved and can be promoted to eval cases.

| Metric | Target |
|---|---|
| Time to first event | < 2 s at p95 |
| Company X-ray | < 90 s and $0 on the default free providers |
| Automation Audit | < 2.5 min |
| Build-an-Agent | < 3 min |
| Citation accuracy | ≥ 95% |
| Eval pass rate | ≥ 85% |
| Attack success rate | 0% |
| Cache hit rate on repeated missions | ≥ 60% where the provider reports caching; "n/a" otherwise |
| Provider smoke test | Every configured model passes `pnpm smoke` before each demo and each merge touching the runtime, or is removed from its chain |

**Honesty:** never fake live output or hard-code AI responses in product paths. Demo fallbacks are real recorded runs, visibly labelled "Replay". Every estimate shows its assumptions.

## Claude Code workflow

Part of the portfolio; set up in M0 and kept sharp:

- `CLAUDE.md` under 150 lines (role, session routine, definition of done, rules, commands); nested `CLAUDE.md` where package conventions differ.
- `.claude/commands/`: `next-task`, `verify`, `eval`, `redteam`, `demo-check`, `adr`.
- `.claude/agents/`: `code-reviewer`, `security-reviewer` (checks against `docs/SECURITY.md`), `eval-analyst`, `ux-critic` (Playwright screenshots at desktop and mobile, critiqued against the design direction).
- Hooks: fast typecheck and lint on edited files; block commits containing secrets; pre-push runs `pnpm check`.
- No hosted CI (owner decision): the `code-reviewer` and `security-reviewer` agents review every change locally against `CLAUDE.md` and `docs/SECURITY.md` before merge.
- Git worktrees and parallel sub-agents for independent workstreams.

## Engineering rules

- **Check current docs before any integration** (Anthropic SDK, server tools, prompt caching, Agent SDK, MCP SDK, Next.js, Inngest, Drizzle, Neon, OTel GenAI conventions). Training data may be outdated.
- **TypeScript strict, no `any`, zod at every boundary**, including every LLM output code consumes, with one repair attempt on parse failure. LLM output is untrusted input.
- **Security is enforced by the runtime, never by prompts.** Capabilities, policies and quarantine are code paths with tests.
- **Prompts are versioned files** in `packages/runtime/prompts/`, each with a header stating its intent. Eval results reference prompt versions.
- **Explicit, boring code.** A reviewer must be able to read the agent loop in one sitting.
- **General solutions only**, never tailored to an eval case or demo company. If a test or spec looks wrong, say so.
- **Never claim something works without running it.** Stubs are listed in `docs/PROGRESS.md`.
- **Respect the outside world:** robots.txt, rate limits, no PRs, messages or posts toward third parties without authorisation and approval.
- **Secrets in env only**; `.env.example` kept current.

## How to work

- **Session start:** read `CLAUDE.md`, the current milestone here, `docs/PROGRESS.md`, `git log --oneline -20`; take the first unchecked item.
- **Plan before building:** a short plan per feature (files, risks, verification). Architectural changes: ADR + plan, then wait for approval.
- **Parallelise:** independent tool calls in parallel; sub-agents for doc research, exploration and reviews.
- **Definition of done for every task:** `pnpm typecheck && pnpm lint && pnpm test` pass; the affected mission ran end to end on a real target; `ux-critic` ran on changed screens at desktop and mobile including loading and error states; runtime or prompt changes ran evals and the red-team suite with no regression; before closing a milestone, `code-reviewer` and `security-reviewer` ran on the milestone diff and findings were fixed.
- **State tracking:** after each task, tick the box here, append to `docs/PROGRESS.md` (date, shipped, next, known issues, metrics), make a small conventional commit.
- **Ambiguity:** ask one concise question rather than improvising architecture. Small implementation choices are the implementer's.

## Roadmap

Every milestone ends deployed and demoable. `main` is always shippable; unfinished work sits behind feature flags. Never start a milestone while an earlier milestone's definition of done is regressed.

### M0 · Foundation
- [x] Monorepo (pnpm + Turborepo) with `apps/web` and the six packages
- [x] Local quality gate (no hosted CI): `pnpm check` runs typecheck, lint, test and build; a git pre-push hook runs it
- [ ] Drizzle schema: orgs, workspaces, members, runs, run_events, artifacts, approvals, audit_log, policies, memories, documents, chunks (pgvector); RLS policies and migration
- [ ] Typed `RunEvent` union, `models.ts`, budget module, policy-engine skeleton, OpenTelemetry setup
- [ ] Design tokens and the home page shell
- [ ] `docs/`: ARCHITECTURE, SECURITY, adr/, PROGRESS, DEMO_SCRIPT
- [ ] Claude Code workflow: CLAUDE.md, commands, agents, hooks (secret scan, pre-push `pnpm check`)
- [ ] *Done when:* `pnpm check` is green, the app is deployed, and the home page already looks premium

### M1 · Agent runtime + Company X-ray
- [ ] Explicit streaming tool-use loop; `web_search` (server tool), `web_fetch`, quarantined reader, `extract`
- [ ] SSE replay-then-live; run view on real events; live cost; budgets; prompt caching
- [ ] Eval harness with the first X-ray dataset
- [ ] *Done when:* a real URL gives a cited brief under the targets, reloading resumes the stream, and the evals run

### M2 · Multi-agent + Automation Audit
- [ ] Planner DAG with approve/edit, dynamic replanning, parallel lanes, critic with claim verification
- [ ] Audit with interactive ROI model; exports; next actions; trace waterfall; local eval gate (`pnpm gate`)
- [ ] *Done when:* the X-ray → Audit chain gives company-specific results for 5 very different companies

### M3 · Build-it + durability + human-in-the-loop
- [ ] Build-an-Agent: crawler, hybrid RAG, widget, gaps report, auto-generated evals
- [ ] Inngest durable runs, approvals, workspace memory
- [ ] *Done when:* **Demo A works end to end** and killing the server mid-run still completes the run

### M4 · Trust layer
- [ ] Policy engine fully enforced, audit log, red-team suite in the local gate, PII redaction
- [ ] Deterministic replay, fork-from-step, run compare
- [ ] `/evals` with CIs, Pareto chart and judge calibration
- [ ] *Done when:* attack success rate is 0% and a fork-and-diff starts in under 10 s

### M5 · Engineering missions
- [ ] Repo X-ray
- [ ] Ship-a-PR (Claude Agent SDK in a sandbox, GitHub App authorisation, patch fallback)
- [ ] *Done when:* a PR passing the repo's tests is opened on one of the owner's repos after approval

### M6 · Platform interfaces
- [ ] REST API, OpenAPI, TypeScript SDK, signed webhooks, CLI
- [ ] MCP server (call Delegate from Claude Code), MCP client connectors, Ops Pulse
- [ ] *Done when:* Demo B steps 1–2 work from a terminal

### M7 · Enterprise
- [ ] RBAC + SSO, policy editor with dry-run, Mission Control
- [ ] Standing missions and triggers, Competitive Intel monitor, Doc Intelligence, Data Analyst
- [ ] BYOK and the provider interface (Bedrock/Vertex), Docker Compose self-hosting
- [ ] *Done when:* **Demo B works end to end**

### M8 · Launch polish
- [ ] Load test; Lighthouse ≥ 90; accessibility audit
- [ ] README (GIF, architecture, metrics table, "How I built this with Claude Code" with real numbers); case-study page; both demo scripts final
- [ ] *Done when:* a stranger succeeds with zero explanation, and both videos can be recorded in one take

**Cut order if time runs short:** Data Analyst → Doc Intelligence → Competitive monitor → SSO → CLI. Never cut evals, security, the hero flows or design quality.
