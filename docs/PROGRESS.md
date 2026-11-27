# Progress log

Append one entry per completed task: date, shipped, next, known issues, metrics. Newest at the bottom.

## 2026-11-24 · Project memory

- **Shipped:** `SPEC.md` (spec + roadmap checkboxes), `CLAUDE.md`, `docs/ARCHITECTURE.md` (system, pipeline, security, event-stream and data-model diagrams), `docs/SECURITY.md` (threat model), ADR 0001 (hand-written runtime), ADR 0002 (quarantined reader), `docs/DEMO_SCRIPT.md`.
- **Versions checked:** Next.js 16.4.6, React 19.3.1, TypeScript 7.0.2, pnpm 12.23.0, Turborepo 2.11.13, Tailwind 4.3.5, Motion 14.14, Recharts 3.11, `@anthropic-ai/sdk` 1.13.0, `@anthropic-ai/claude-agent-sdk` 0.3.331, `@modelcontextprotocol/sdk` 1.32.2 (protocol 2025-11-25), Drizzle ORM 0.45.4 / kit 0.31.11, `@neondatabase/serverless` 1.2.1, Inngest 4.27.0, Upstash Redis 1.41.1 / Ratelimit 2.2.2, E2B 2.64.0, OpenTelemetry API 1.10.0 / SDK 0.301.2 / semconv 1.45.0, Vitest 5.1.1, Playwright 1.65.1, zod 4.6.7.
- **Next:** M0 plan review with the owner, then M0 implementation.
- **Known issues:** none yet; no code exists.
- **Stubs:** none.

## 2026-11-24 · Zero-cost operating constraint

- **Decided:** the owner spends $0 forever. ADR 0003 replaces Claude-only routing with role-based fallback chains across free open-weight providers; Claude becomes BYOK. Research is keyless.
- **Research sources (read 2026-11-24):** NVIDIA NIM catalog and Kimi K3 card (docs.api.nvidia.com), OpenRouter limits and privacy docs, Groq rate limits and data docs, Cerebras rate limits and models, Cloudflare Workers AI pricing, Z.ai pricing, Tavily/Jina/Brave search docs. Retired in 2026: GitHub Models (2026-07-30), Hugging Face free credits, Chutes free tier.
- **Unverified (check in M1 with real keys):** actual NVIDIA limits, Cerebras/Groq card requirements, Kimi tool calling on Cloudflare, Z.ai limits.
- **Next:** owner approval of the revised M0 plan.

## 2026-11-24 · Keyless default and no hosted CI

- **Decided:** no hosted CI (local `pnpm check` + pre-push hook, `pnpm gate` for evals/red-team). Default inference needs no keys: keyless hosted open models (Pollinations, LLM7) → in-browser WebLLM → local Ollama; free-tier keys and BYOK Claude are optional extras. ADR 0003 amended.
- **To verify in M1:** current Pollinations/LLM7 endpoints, limits, terms and tool calling; WebLLM model list with function calling.

## 2026-11-24 · M0 monorepo foundation and local quality gate

- **Shipped:** pnpm workspace (`apps/*`, `packages/*`) with a version catalog in `pnpm-workspace.yaml`, Turborepo pipelines (`build`, `typecheck`, `lint`, `test`, `dev`, root `lint:root`/`test:root`), strict `tsconfig.base.json` (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, bundler resolution, ES2024), one ESLint flat config (`typescript-eslint` strict + stylistic type-checked, `no-explicit-any` error, Next and React Hooks rules for `apps/web`), Prettier, `.editorconfig`, `.nvmrc`, `.env.example`. Packages `@delegate/{db,runtime,policy,evals,sdk,mcp-server,cli}` and `@delegate/web` (Next.js App Router, Tailwind v4, self-hosted fonts, shadcn `components.json` + hand-written `Button`) importing `@delegate/runtime` to prove cross-package builds. Git hooks via `simple-git-hooks`: pre-commit runs `scripts/scan-secrets.mjs --staged` and a Prettier check of staged files; pre-push runs `pnpm check`. Root scripts `check`, `gate` and `smoke` (the last two are placeholders until M1/M4).
- **Versions:** pnpm 12.23.0, Turborepo 2.11.13, TypeScript 6.0.3, Next.js 16.4.6 (Turbopack build), React 19.3.1, Tailwind 4.3.5, ESLint 10.15.0, typescript-eslint 8.74.0, Prettier 3.10.1, Vitest 5.1.1, Playwright 1.65.1 (no browsers downloaded), zod 4.6.7, drizzle-orm 0.45.4 / drizzle-kit 0.31.11, `@neondatabase/serverless` 1.2.1, PGlite 0.6.0 + `@electric-sql/pglite-pgvector` 0.1.0, `@anthropic-ai/sdk` 1.13.0, `@modelcontextprotocol/sdk` 1.32.2, OpenTelemetry API 1.10.0 / `sdk-trace` 3.1.1 / `exporter-trace-otlp-http` 0.301.2 / semconv 1.45.0, Motion 14.14.0, Recharts 3.11.1, lucide-react 1.79.0.
- **Deviations:** TypeScript 6.0.3 instead of 7.0.2 because `typescript-eslint` 8.74.0 (latest) declares `typescript >=4.8.4 <6.1.0`; strict type-checked linting is a hard requirement, so TS 7 waits for typescript-eslint support. ESLint 10 is used without `eslint-config-next`, because that preset pulls `eslint-plugin-react`, `-import` and `-jsx-a11y`, which only support ESLint 9; `@next/eslint-plugin-next` and `eslint-plugin-react-hooks` (both ESLint 10 compatible) are wired directly. OpenTelemetry: the 3.x SDK merged `sdk-trace-base`/`sdk-trace-node` into `@opentelemetry/sdk-trace`; the 2.x packages require `@opentelemetry/api <1.10`, so the 3.x line is used, plus `context-async-hooks` and `resources`; `sdk-node` was not added (it pulls gRPC, Zipkin and Prometheus exporters). Fonts are self-hosted via `@fontsource` instead of `next/font/google`, so `next build` never needs the network. Markdown is excluded from Prettier so author-formatted docs and tables are not re-padded.
- **Install policy:** pnpm 12 enforces a minimum release age; it auto-added `minimumReleaseAgeExclude` entries for `@anthropic-ai/sdk@1.13.0`, `lucide-react@1.79.0` and `recharts@3.11.1` (published within the window). `allowBuilds` permits only `esbuild` postinstall; `simple-git-hooks` is denied (hooks are installed by the root `prepare` script).
- **Next:** Drizzle schema + RLS (db), `RunEvent` union / `models.ts` / budget / OTel setup (runtime), policy-engine skeleton, design tokens and home page shell.
- **Known issues:** git hooks call `node` and `pnpm` from git's `PATH`; with Node in `~/.local/node/bin` that directory must be on the login `PATH` (or set `SIMPLE_GIT_HOOKS_RC`) or the hooks fail. Package `build` emits `dist/` with extensionless ESM imports (bundler resolution), fine for Next and Vitest but not yet runnable by plain Node; the CLI and MCP server will need a bundling step or `.js` specifiers when they ship.
- **Stubs:** every package's `src/index.ts` exports only `packageName`; `packages/db/src/schema/index.ts` is empty; `pnpm gate` equals `pnpm check` plus a notice; `pnpm smoke` prints that it arrives in M1; `apps/web` home page is a placeholder pending the design-token task; `e2e/home.spec.ts` exists but is not part of `pnpm check` (needs `pnpm exec playwright install`).

## 2026-11-24 · M0 foundation built, reviewed and hardened

- **Shipped:** `packages/db` (13 tables, FORCE RLS on all, non-owner app login role, SECURITY DEFINER write paths for approvals, audit, usage and retention, append-only logs with triggers, pgvector + tsvector hybrid search); `packages/runtime` (20-type `RunEvent` union with `foldRun`, keyless-first `config/models.json`, classification-aware chain resolution, `ModelRouter` with fallback/health/timeouts, hardened SSE parser, OpenAI-compatible and Anthropic BYOK adapters, budgets in micro-USD, OTel GenAI spans without bodies); `packages/policy` (declarative engine, built-in baseline: side effects need approval, egress needs a declared allowlisted target, blocked IP/localhost/metadata hosts, fails closed); `packages/evals` (t and Wilson intervals, one-sided Welch regression test); `apps/web` (design tokens, home page, ⌘K palette, roadmap placeholders, nonce CSP + security headers); Claude Code workflow (6 commands, 4 review agents, edit-lint hook); secret-scan pre-commit and `pnpm check` pre-push hooks.
- **Reviews:** code review (22 findings) and security review (16 findings, 3 high: owner connection escaping RLS, self-approval, forgeable audit) all fixed test-first; harness session logs removed from git history before any push.
- **Metrics:** `pnpm check --force` 34/34 tasks; tests: db 170, runtime 153, policy 69, evals 48, web 123, root scripts 79 (642 total); secret scan 225 files clean; CSP verified in a real browser (no violations, palette hydrates).
- **Next:** deploy (owner creates free Vercel + Neon accounts), run migrations on Neon, verify roles there; then M1.
- **Known issues / follow-ups:** real-concurrency tests need a multi-connection Postgres (PGlite is single-connection); Neon role setup untested; keyless endpoints and several model IDs marked `unverified` until M1 smoke tests; Anthropic SDK OTel content mode not forced off; guest $0 spend cap vs visitor BYOK needs an M1 decision; no workspace-deletion path yet.
- **Stubs:** `packages/sdk`, `packages/mcp-server`, `packages/cli` (scaffolds only); `pnpm gate` and `pnpm smoke` are placeholders until M1/M4.

## 2026-11-24 · M1 runtime, Company X-ray, run view and eval harness

- **Shipped:** hand-written streaming tool-use loop with capability + policy checks on every call; SSRF-hardened fetch (DNS checked per hop and inside the socket lookup, robots.txt, rate and page caps); HTML-to-text with hidden-text injection signals; keyless research tools (site crawl, Wikipedia/Wikidata, GitHub, RSS); quarantined reader with verbatim-quote verification; Company X-ray mission with code-enforced citations and honest "insufficient evidence" sections; guest workspaces via `create_guest_workspace()`; run API, SSE replay-then-live, cancel, stale-run sweeper; three-column run view with mobile tabs; eval harness (8-company dataset, deterministic graders, versioned judge, offline replay, `pnpm eval`, `pnpm gate`); real `pnpm smoke`; NVIDIA discovery and ADR 0003 amendment 2.
- **Metrics (live):** guest run via the web stack on linear.app 31.9 s, 13 claims, 13/13 citations valid, $0, resume after disconnect with no gaps; browser run on vercel.com 1 m 03 s, 6/8 sections supported, 11/11 citations resolved, $0; supabase.com 63 s (keyless) and 86.6 s (owner). Injection test: hidden instruction flagged, metadata fetch denied by policy, never reached a model. `pnpm check` 34/34; tests: runtime 406, db 174, web 213, evals 77, policy 72, root 79.
- **Fixed during browser check:** repo-root resolution no longer depends on the server's start directory; the brief panel no longer renders a source snapshot while the brief is being written.
- **Next:** M2 (planner DAG, parallel sub-agent lanes, critic with claim verification, AI Automation Audit with ROI sliders).
- **Known issues:** keyless Pollinations throttles to about one call per 40 s, so some sections come back as insufficient evidence; NVIDIA chain (Nemotron 3 Ultra, Mistral Large 4, Nemotron Lightning) is owner/evaluation-only and not yet run as a full mission; live eval not yet run (harness built, results pending); NVIDIA context windows unverified; Vercel deploy needs prompt files and migrations traced into the output.

## 2026-11-25 · M2 agent teams and AI Automation Audit

- **Shipped:** planner that composes a validated step DAG from each mission's step library (default plan when the planner is slow or fails); orchestrator running sub-agents in parallel with per-step budgets, a provider gate and capped replanning (`plan.revised` with diffs); critic that verifies atomic claims against whole quotes, fixes, keeps weak support, removes contradicted or uncited claims, and always reports citation accuracy; Company X-ray refactored onto the team; AI Automation Audit mission (department lenses, genericity guard, realistic ROI caps, `estimateRoi`, next actions); web plan-approval card with editable steps, parallel agent lanes, plan diffs, critic flags, Audit panel with live ROI sliders and Markdown/CSV/JSON/print exports, trace waterfall at `/runs/[id]/trace`; ADR 0006.
- **Metrics (live):** Audit on gocardless.com (owner, NVIDIA chain) 140 s, $0, 6 opportunities, citation accuracy 84% (first pass 64%), top opportunity €12,800/month with company-specific evidence; X-ray on ecosia.org (keyless) 192 s, 17 claims, critic 18/18. Web real Audit on posthog.com exercised approval, edit, lanes and trace end to end (before critic calibration). `pnpm check` 34/34; tests: runtime 450, web 240, evals 77, policy 72.
- **Next:** M3 (Build it: crawler, hybrid RAG, cited assistant and widget; durable runs; approvals; workspace memory).
- **Known issues:** keyless X-ray now about 190 s (target 90 s) because of extra reader and critic calls on a throttled provider; editor fix loop can over-narrow workflow text; X-ray → Audit chaining (`fromRunBrief`) not implemented; Audit quality shown on one company so far (M2 "5 companies" criterion not yet met); long plan-approval waits exceed Vercel's function limit until durable runs land in M3.

## 2026-11-25 · M3 Build it, durable runs, model ranking

- **Shipped:** Build-an-Agent mission (polite crawler, chunking, hybrid full-text + vector retrieval with RRF and rerank, assistant designer, auto-generated eval set with self-evaluation, gaps report); streaming cited chat (`answerQuestion`) with grounded refusals; `/agents`, `/agents/[id]` (chat, Embed, Evals, Gaps, Settings), `/embed/[id]` and `/widget.js` with framing allowed only for embeds; Build it buttons on Audit opportunities; durable resume from the event log with db leases (ADR 0007, no job service); retrieval without paid embeddings (ADR 0008, NVIDIA `nemotron-3.5-embed-1b` at 1024 dims when a key exists); workspace memory; max-quality mode routing quality-critical steps to Kimi K3.1 Pro with long timeouts and fallback; NVIDIA model bake-off and ranked rotation with automatic return to the best model (ADR 0003 amendments 3 and 3b).
- **Metrics (live):** Build-an-Agent on plausible.io (owner chain) 150 s, 60 pages, 491 chunks, evals 12/12, resume after kill skipped finished steps and refetched nothing; full web flow Audit → Build it → assistant on the keyless chain: Audit ~7 min, build 24 min, evals 11/15 with all refusal cases passing, cited answers and correct refusal; Kimi K3.1 Pro served the max-quality design step in 204 s. Bake-off: MiniMax M3.1 Flash 1.000, Step 5 0.988, Kimi K3.1 Pro 0.975, Mistral Large 4 0.750, Nemotron Super 0.725, Nemotron Ultra 0.675. `pnpm check` 34/34; tests: runtime 497, web 268, db 178, evals 77, policy 72.
- **Next:** full Demo A pass in the browser, deploy, then M4 trust layer.
- **Known issues:** keyless chain is slow for Build it (about 24 min); assistant retrieval stores are in memory per process, so chat refuses after a restart until a Postgres-backed store lands; real kill-and-restart resume of the web server not exercised (decision logic unit-tested); max-quality end-to-end run on the final config not yet completed; live rotation now waits ~5–11 s for MiniMax's first token on high-volume calls.

## 2026-11-25 · Deployed

- Live at https://delegate-beryl.vercel.app (Vercel Hobby + Neon free tier).
- `scripts/neon-setup.sh` runs migrations as the Neon owner, sets the `delegate_app_login` password and writes the Vercel variables to a private gitignored file.
- Two migration fixes found on real Postgres (non-superuser owner): `GRANT delegate_definer ... WITH SET TRUE`, and a temporary `CREATE ON SCHEMA public` for `delegate_definer` around each `OWNER TO`, revoked straight after.
- First live run: Company X-ray on plausible.io finished in 2m41s, 21/21 citations resolved, citation accuracy 86%, $0. MiniMax returned server errors from Vercel's region and every call fell back to Nemotron 3.5 Super VL.
- Home page now shows the live model chain and marks shipped missions as Live.

## 2026-11-25 · M4 trust layer

- **Red-team suite** (`pnpm redteam`, in `pnpm check`): 56 deterministic attacks across indirect injection, exfiltration, SSRF, capability escalation, approval bypass and quote forgery, run against the real guards with a scripted compromised model. ASR 0%. Building it found and fixed four real gaps: mid-word quote matches, injected instructions relayed as facts, zero-width/fullwidth trigger phrases, and plan steps granted capabilities their executor does not declare.
- **Fork from step, replay, run compare** (ADR 0009): forks seed a new run from the parent's event log and continue through the durable resume path. Local fork: 7 ms seed, first new event 1.1 s. Replay plays the log back client-side; `/runs/compare` diffs briefs claim by claim.
- **`/evals` scoreboard**: Wilson and t intervals, Pareto chart (tokens vs quality), judge calibration with a kappa interval, red-team card. Reads committed result files only.
- **PII redaction** in the runtime emitter (emails, phones, Luhn-checked cards, mod-97 IBANs), counts only. **Audit log** at `/control/audit` from `policy.decided` events, RLS-scoped, fork-seeded copies excluded.
- Milestone review found two real bugs (audit double-count on forks; quote boundary check rejecting CJK and compound quotes) and four smaller issues; all fixed with tests.
- Live eval found that pages over 2 MB failed the whole X-ray; the fetcher now keeps the capped prefix. Eval CLI now uses the same NVIDIA chain as the deployed site.
- **Live X-ray eval** (8 companies × 2 trials, NVIDIA free tier): pass 81% [57%, 93%], deterministic score 0.91 ± 0.09, judge 0.75 ± 0.10, p50 61 s, p95 81 s, $0. LEGO blocks automated fetches (403); one Rakuten trial failed synthesis validation.
- Not done: judge-human agreement has no human labels yet; Audit and Build it have no eval datasets yet.

## 2026-11-25/26 · M5 engineering missions and platform upgrades

- **Repo X-ray** (ADR 0010): codeload tarball ingestion with caps, deterministic analysis, model steps on evidence ids only, line-level citation critic. Live on LiamSDD/claude-ledger: 2m35s, 7 ranked improvements, 71% supported (24 claims checked).
- **Ship-a-PR** (ADR 0011): own Engineer loop on the free chain, Vercel Sandbox, ship approval of the exact diff, PR pushed from the approved bytes only, GitHub App with single-repo tokens and push-access check at ship time, patch fallback. Live and configured; no live PR yet (owner chose not to connect a personal repository).
- **Custom goals** run live (no more draft page). Live: "I want to achieve nike's marketing and agentic work" → nike.com via Wikidata, 1m59s, 15/15 claims verified, 4 ranked actions. Briefs still include generic background; addressed in the next round.
- **Crawl engine** (ADR 0012): 32 workers, 6 per host, Crawl-delay and Retry-After honoured with caps. 150 pages of docs.python.org in 15.5 s (was >150 s).
- **Evolving playbooks** (ADR 0013): lessons from run outcomes, per-workspace and house playbooks, eval-gated `pnpm evolve`.
- **Connections** (ADR 0014): `/api/mcp` for Claude Code, Codex, Cursor and VS Code; MCP client connectors with quarantined output and exact-argument approvals; Connect GitHub.
- Hard deadlines and checkpoint resume for custom goal and Repo X-ray; host-gate waits abortable.
- Two independent reviews found 2 high and 2 blocking issues plus 9 smaller ones; all fixed with tests. Red-team: 106 attacks across 10 categories, 0 successes.
- Migrations 0005–0008 applied to Neon with `scripts/neon-migrate.sh`.

## 2026-11-27 · Runtime quality fixes from live runs

- **Repo X-ray fixture tokens**: on sindresorhus/ky the #1 improvement was rotating a fixture token in `test/hooks.ts`. Secret findings now carry a confidence: test, fixture, example, mock and spec paths, and placeholder-like values (placeholder words, dictionary words plus digits, low-entropy provider formats), are low confidence, aggregated into one low-severity "Test fixture tokens, verify not real" hotspot, kept out of the improver's evidence and dropped in code if the improver still proposes rotating them. Real provider-format tokens in production paths stay high severity. The reported line 4061 was correct (the file has 8,063 lines).
- **Goal coverage** (`goal-coverage.v1.md`, `fast` role, zod-parsed with one repair): grades whether the brief answers the goal (answered, partly, not answered) with the missing aspects. A custom goal about PSF licences produced a brief about GitHub repo counts at 100% citation accuracy; coverage is now graded before deep research (unanswered aspects become the first thin sections and reference searches, within the existing two-round bound) and again after the critic when the brief changed. Shown next to citation accuracy in the top bar, the goal panel, the critic report and the run summary; flagged as `critic.flagged` when not answered or unchecked. The custom-goal eval grader gains a soft `goal_answered` check and a `goalCoverage` metric.
- Not run: live `/eval` and `/redteam` (paid or keyed providers); covered by scripted-provider tests.

## 2026-11-27 · Live demo robustness

- **Built assistants answer after Build it** (owner chat said "No sources indexed"): Build-it indexed pages into a per-process memory store; the chat ran on another serverless instance. Missions and owner chat now read and write the workspace's `documents` and `chunks` tables. The owner's embed preview loads the assistant from the database too.
- **No more false "worker lost"** for Autopilot children and long runs: scheduled work starts at once instead of after the response (a run page's event stream delayed it by up to 300 s); a run waiting for plan approval parks without a worker and continues when the decision is recorded; runs hand off to a new invocation 25 s before the 300 s limit; one failed lease renewal is tolerated. ADR 0007 amendment.
- **Autopilot briefs are flagged** when citation accuracy is under 70%, more than 5 claims are weak, or goal coverage is not "answered": the child still completes and feeds the next mission, and the report lists what to check.
- No migration.
