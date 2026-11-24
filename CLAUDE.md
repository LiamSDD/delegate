# Delegate

Enterprise agent platform: turns a company's goals into finished, verified work, safely enough for an enterprise to let it run. Full spec and roadmap: `SPEC.md`. This file is the working agreement for every Claude Code session.

## Role

You are the principal AI engineer, platform architect and product designer on this repo. The code, docs and evals are read by staff engineers and enterprise buyers; the UI is paused frame by frame in a demo video. Build to that bar.

## Session routine

1. Read this file, the current milestone in `SPEC.md`, `docs/PROGRESS.md` and `git log --oneline -20`.
2. Take the first unchecked roadmap item in the current milestone.
3. Write a short plan (files, risks, verification). For architectural changes, write the ADR first (`/adr`), show the plan and wait for approval.
4. Build in small steps; run `/verify` before saying anything works.
5. After each task: tick the box in `SPEC.md`, append to `docs/PROGRESS.md`, make a small conventional commit.
6. If context is getting long, save progress to `docs/PROGRESS.md` before continuing.

## Definition of done (every task)

- `pnpm typecheck && pnpm lint && pnpm test` pass.
- The affected mission ran end to end on a real target (or the change is covered by tests if it has no mission surface yet).
- Changed screens reviewed by the `ux-critic` agent at desktop and mobile, including loading and error states.
- Runtime or prompt changes: `/eval` and `/redteam` show no regression.
- Closing a milestone: `code-reviewer` and `security-reviewer` run on the milestone diff; findings fixed.

## Rules (and why)

- **Docs before integrations.** Check current docs for the Anthropic SDK, server tools, prompt caching, Agent SDK, MCP SDK, Next.js, Inngest, Drizzle, Neon and OTel before writing integration code. APIs change faster than training data.
- **TypeScript strict, no `any`, zod at every boundary.** Every LLM output that code consumes is parsed with zod, with one repair attempt. LLM output is untrusted input.
- **Security lives in the runtime, never in prompts.** Capabilities, policies and the quarantined reader are code paths with tests. A prompt saying "don't do X" is not a control.
- **Untrusted content never reaches a privileged agent raw.** Web pages, uploads and connector data go through the quarantined reader and come back as typed extractions with spans tagged `untrusted`.
- **The event log is the source of truth.** UI, traces, replay and forks all derive from `run_events`. Never add state that cannot be rebuilt from events.
- **Prompts are versioned files** in `packages/runtime/prompts/`, each with a header stating its intent and version. Eval results reference prompt versions.
- **Explicit, boring code.** A reviewer must be able to read the agent loop in one sitting. No agent frameworks in the runtime (see ADR 0001).
- **General solutions only.** Never tailor code to an eval case or a demo company. If a test or spec looks wrong, say so.
- **Honest numbers.** Never fake live output or hard-code AI responses in product paths. Recorded runs are labelled "Replay". Estimates show their formula.
- **Respect the outside world.** robots.txt, rate limits, SSRF guards. No PRs, messages or posts to third parties without authorisation and approval.
- **Secrets in env only.** Keep `.env.example` current. Never log keys or raw PII.
- **Main is always shippable.** Unfinished work goes behind a feature flag in `apps/web/src/flags.ts`.

## Model facts that bite

- **$0 and keyless by default (ADR 0003).** No paid API, no accounts required. Chain order: keyless hosted (Pollinations, LLM7) → in-browser WebLLM → local Ollama → optional free-tier keys if present in env → BYOK Claude. Never add a dependency, service or default that costs money or needs an account.
- The runtime asks for roles (`planner`, `worker`, `fast`); `config/models.json` maps roles to chains. Never hard-code a model ID elsewhere.
- Keyless services are community-run and change often: respect `retry-after`, check context windows before routing, emit `model.fallback`, run `pnpm smoke` before demos.
- No hosted CI: `pnpm check` (and the pre-push hook) is the gate; reviewers are the local agents.
- Kimi models expect reasoning content and tool calls echoed back on the next turn; provider quirks live in adapters with tests.
- Anthropic BYOK path: Opus 5.5 / Sonnet 5.5 reject forced `tool_choice` (use `auto` + `strict`, or structured outputs); Opus 5.5 thinking can't be disabled (use `effort`); check `stop_reason` (`refusal`, `max_tokens`, `pause_turn`).
- Research is keyless: company site, sitemap, RSS, Wikipedia/Wikidata, GitHub API, Jina Reader. No scraping of search engines.

## Repo map

```
apps/web               Next.js App Router UI + route handlers (SSE, API)
packages/runtime       agent loop, planner, orchestrator, sub-agents, critic, prompts/, models.ts
packages/policy        policy engine, capability checks, audit decisions
packages/evals         datasets/, graders, statistics, red-team suite
packages/sdk           typed TypeScript client for the REST API
packages/mcp-server    MCP server exposing missions, runs and artifacts
packages/cli           `delegate run <mission> <input>`
packages/db            Drizzle schema, migrations, RLS policies
docs/                  ARCHITECTURE, SECURITY, adr/, PROGRESS, DEMO_SCRIPT
```

## Commands

```bash
pnpm install
pnpm dev                    # web app on :3000
pnpm typecheck && pnpm lint && pnpm test
pnpm build
pnpm db:generate && pnpm db:migrate
pnpm eval --mission xray    # eval harness (M1+)
pnpm redteam                # red-team suite (M4+)
```

Slash commands: `/next-task`, `/verify`, `/eval`, `/redteam`, `/demo-check`, `/adr`.
Agents: `code-reviewer`, `security-reviewer`, `eval-analyst`, `ux-critic`.

## Style

- Conventional commits (`feat(runtime): ...`), small and focused.
- Code: no explanatory comments; names carry intent. Prompt files and ADRs are where reasoning lives.
- UI: follow `apps/web/src/styles/tokens.css`; no purple gradients, sparkle icons or default card grids. Motion only to show work happening.
