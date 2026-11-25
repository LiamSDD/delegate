# ADR 0003: Zero-cost, keyless-first model routing

- Status: Accepted
- Date: 2026-11-24
- Supersedes: the Claude-only model routing in the original spec (Claude stays as an optional bring-your-own-key provider)

## Context

The owner runs Delegate for $0, indefinitely: no paid API, no card on file. Delegate still needs strong models with tool calling, streaming, structured output and long context. Free hosted inference for open-weight models exists, but each free tier is small, rate-limited, and changes often (GitHub Models, Hugging Face free credits and Chutes all disappeared during 2026). Research on 2026-11-24 (sources in `docs/PROGRESS.md`):

| Provider (OpenAI-compatible) | Strongest free models with tool calling | Free limits | Notes |
|---|---|---|---|
| NVIDIA API catalog (`integrate.api.nvidia.com/v1`) | `moonshotai/kimi-k3`, `deepseek-ai/deepseek-v4-pro`, `z-ai/glm-5.3`, `minimaxai/minimax-m2.7` | about 40 RPM per key (unofficial), long context | Trial terms: development and evaluation, not production |
| Groq (`api.groq.com/openai/v1`) | `openai/gpt-oss-120b`, `qwen/qwen3.8-27b` | 30 RPM, 1K RPD, 8K TPM, 200K TPD | Zero data retention can be enabled |
| Cerebras (`api.cerebras.ai/v1`) | `gpt-oss-120b`, `qwen-3.8-27b` | qwen: 300 RPM, 64k context on free tier | Very fast |
| OpenRouter (`openrouter.ai/api/v1`) | `nvidia/nemotron-3-ultra-550b-a55b:free`, `google/gemma-4-31b-it:free` | 20 RPM, 50 RPD | Per-provider data policies |
| Cloudflare Workers AI | `@cf/openai/gpt-oss-120b`, `@cf/zai-org/glm-4.7-flash` | 10,000 neurons/day | States no training on customer data |

## Decision

1. **One `ModelProvider` interface, two adapters:** an OpenAI-compatible adapter (covers every free provider above) and an Anthropic adapter (bring-your-own-key, used when a visitor or self-hoster supplies a Claude key). The runtime only sees normalised messages, tool calls, usage and stop reasons.
2. **Roles, not models.** The runtime asks for `planner`, `worker` or `fast`. `config/models.json` maps each role to an ordered fallback chain of `{provider, model}` entries, with each entry's context window, tool-call quirks and limits. Changing providers is a config change, not a code change.
3. **Router** in front of the providers: per-provider token buckets, `retry-after` handling, a context-window check before routing, health-based skipping after repeated failures, and a `model.fallback` event whenever it moves down a chain, so the UI and traces show which model actually served each call.
4. **Initial chains:**
   - `planner`: NVIDIA `kimi-k3` → NVIDIA `deepseek-v4-pro` → OpenRouter `nemotron-3-ultra:free` → Groq `gpt-oss-120b`
   - `worker`: Groq `gpt-oss-120b` → NVIDIA `glm-5.3` → Cerebras `gpt-oss-120b` → Cloudflare `gpt-oss-120b`
   - `fast`: Cerebras `qwen-3.8-27b` → Groq `qwen3.8-27b` → Cloudflare `glm-4.7-flash`
5. **Public demo vs owner runs.** NVIDIA's trial terms are for evaluation, so the public guest workspace uses the non-NVIDIA chains by default, with strict per-visitor quotas and a designed "free capacity used up" state. Owner-run evaluations and demo recordings may use NVIDIA. Visitors can bring their own Claude key to run live on Claude.
6. **Honesty in the UI.** Every run shows which provider and model served each step, and recorded runs are labelled "Replay" with the models used.
7. **A daily smoke test** calls each configured `{provider, model}` with a tiny tool-calling prompt and records pass/fail, so a disappearing free tier shows up before a demo does.

## Consequences

- $0 running cost; capacity is a few hundred agent runs a week across providers, enough for a portfolio demo and evals.
- Quality and latency vary by provider; evals record the serving model on every trial so comparisons stay valid, and the model × prompt Pareto chart compares free models directly.
- Provider-specific behaviour (Kimi expects reasoning content and tool calls echoed back, smaller free context windows, different caching) lives in adapter code with tests.
- Prompt caching is provider-dependent; the cache hit rate is reported where the provider exposes it and shown as "n/a" otherwise, never estimated.
- Claude-specific features (server-side web search, Claude Agent SDK) are not used on the default path. Web research uses keyless sources (ADR 0004, M1). The Engineer sub-agent (M5) will be redesigned on the hand-written runtime with a free sandbox option; a new ADR will record that.
- Data-use differs by provider; `docs/SECURITY.md` lists it, and the policy engine can block providers for workspaces that classify data as confidential.

## Amendment (2026-11-24, same day): keyless first, no hosted CI

The owner will not create provider accounts or manage keys, so the default path must need **no keys at all**. Chain order per role:

1. **Keyless hosted open models:** Pollinations classic text endpoint (tool-capable gpt-oss) and LLM7 anonymous access, both OpenAI-compatible. Community-run, smaller models, limits change without notice; verified with `pnpm smoke` before demos.
2. **In-browser models:** WebLLM on WebGPU (Chrome/Edge), with OpenAI-style function calling; runs on the visitor's GPU, keyless and private ("Private mode"). Small models, so used for the fast role and as the last fallback.
3. **Local Ollama:** keyless; self-hosting, owner evals and demo recordings.
4. **Optional free-tier keys** (NVIDIA Kimi K3, Groq, Cerebras, OpenRouter, Cloudflare): supported by the same adapter, used only if their env vars are present. The owner may add them later; nothing depends on them.
5. **BYOK Claude.**

Quality on the keyless path is lower than Kimi K3 or Claude; evals record the serving model so this is visible, never hidden.

There is no hosted CI. `pnpm check` (typecheck, lint, test, build) runs locally and in a pre-push hook; `pnpm gate` adds evals and the red-team suite; the `code-reviewer` and `security-reviewer` agents review changes locally.

## Amendment 2 (2026-11-24): measured NVIDIA chains, latency budget, keyless default

**Measurements.** `pnpm --filter @delegate/runtime live:nvidia` lists the owner's catalog (30 models on 2026-11-24) and sends each candidate one streaming tool-calling request (`get_weather`, `tool_choice: auto`), sequentially, ≥1.6 s apart, 75 s cap. 19 probes in total:

| Model | HTTP | First token | Total | Tool call |
|---|---|---|---|---|
| `nvidia/nemotron-3-ultra-550b-a55b` | 200 | 0.4 s / 2.4 s (two probes) | 1.1 s / 3.5 s | correct |
| `mistralai/mistral-large-4-1t-a52b` | 200 | 0.4 s / 0.6 s | 1.5 s / 2.1 s | correct |
| `nvidia/nemotron-3.5-lightning-30b-a3b` | 200 | 0.2 s | 0.4 s | correct |
| `nvidia/nemotron-3.5-bolt-e4b` | 200 | 0.3 s | 0.3 s | correct |
| `poolside/laguna-xs-2.1` | 200 | 0.9 s | 0.9 s | correct |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` | 200 | 0.3 s | 1.4 s | correct |
| `nvidia/nemotron-3.5-super-vl-120b-a12b` | 200 | 17.9 s | 18.3 s | correct |
| `minimaxai/minimax-m3.1-flash` | 200 | 18.6 s / 19.7 s | 18.8 s / 20.1 s | correct |
| `stepfun-ai/step-5-preview` | 200 | 23.0 s | 28.4 s | correct |
| `moonshotai/kimi-k3.1-pro` | 200 | none within 75 s (3–4 min observed earlier) | timeout | – |
| `z-ai/glm-5.3-flash` | – | none within 75 s (two probes) | timeout | – |
| `google/gemma-3-12b-it` | 404 | – | – | – |
| `moonshotai/kimi-k3`, `deepseek-ai/deepseek-v4-pro`, `z-ai/glm-5.3` | 410 | – | – | – |

One probe per model is a latency sample, not a benchmark; the context windows of the new entries are not yet confirmed and stay `unverified`.

**Chosen chains** (owner runs with `NVIDIA_API_KEY`; NVIDIA entries are dropped entirely for the public demo):

- `planner`: Kimi K3.1 Pro (`interactive: false`) → Nemotron 3 Ultra → Mistral Large 4 → Pollinations `openai` → WebLLM → Ollama → OpenRouter → Groq → Claude (BYOK)
- `worker`: Nemotron 3 Ultra → Mistral Large 4 → Pollinations `openai` → WebLLM → Ollama → Groq → Cerebras → Cloudflare → Claude (BYOK)
- `fast` (quarantined reader): Nemotron 3.5 Lightning 30B-A3B → Pollinations `openai` → WebLLM → Ollama → Cerebras → Groq → Cloudflare → Claude (BYOK)

The 410 entries (`kimi-k3`, `deepseek-v4-pro`, `glm-5.3`) are removed.

**Latency budget instead of a separate role.** A chain entry may set `interactive: false`. The router skips those entries unless the run sets `latency: "offline"` (`RunMissionOptions.latency`, `ChainContext.latency`). The default is `interactive`, so web runs never wait minutes for a first token. Evals, judges and recordings that want the strongest model pass `offline` and get Kimi K3.1 Pro first. `pnpm smoke` reports these entries as `skip (offline only)`. A separate `quality` role was rejected because `ModelRole` is part of the event schema and the database parity tests. Adding a role would change the event contract to express what is really a per-run budget.

**Evaluation-only rule.** NVIDIA keeps `terms: "evaluation-only"`. `isProviderAvailable` excludes it for the `public-demo` audience whatever the env holds. Only owner runs (local `DELEGATE_OWNER_MODE=1`, evals, recordings) reach it.

**Ordering rule, corrected.** Decision 4 and Amendment 1 said "keyless first", but `config/models.json` and its test let evaluation-only entries lead. The precise rule, which the test enforces: a role may open with evaluation-only entries (owner-only, never served to the public demo). From the first keyless entry on, the order is keyless hosted → browser → local → optional free-tier keys → BYOK. For the public demo the resolved chain therefore always starts keyless.

**Keyless default and its cost in quality.** With no keys, every role resolves to Pollinations `openai` (gpt-oss-20b). It is community-run and anonymous. It throttles to about one call per 40 s after the first in a run, so the router spaces calls at 1.5/min with one in flight. It also stops completions at about 1500 tokens, reasoning included. As a result, public-demo runs take minutes, not seconds. Synthesis gets a smaller output budget than the owner path, so the reader extracts fewer facts per page and more sections end as "insufficient evidence". Evals record the serving model on every trial, so this gap is measured and shown, never hidden.

## Amendment 3 (2026-11-25): bake-off ranking, priority rotation, NVIDIA on the public demo, max quality mode

**Kimi K3.1 Pro latency, measured.** The 2026-11-24 probe gave no first token within 75 s. In today's bake-off, with a 300 s first-token budget, Kimi answered all 8 calls: first token 100–153 s (median 130 s), total 115–170 s. It is correct but far too slow for any interactive step.

**Bake-off.** `src/live/nvidia-bakeoff.live.test.ts` runs 4 Delegate-shaped tasks twice per model, sequentially per model (Kimi's 4 tasks run in parallel per round to keep the run under 15 minutes). The key is loaded inside the program and never printed. Candidates are every catalog chat model that returned a correct tool call in under 60 s in discovery, plus Kimi with 300 s/600 s timeouts. Fast models get 60 s first token and 120 s total. Grading is in code where possible:

1. Extraction: JSON facts with quotes. Pass = schema valid and every quote is an exact substring of the page (whitespace-normalised).
2. Multi-tool call: `get_weather(Lisbon)` and `convert_currency(250, EUR, USD)` in one turn, with a distractor tool. Pass = both correct, no distractor.
3. Automation write-up from evidence: a different model judges it 1–5 for specificity and grounding (Nemotron 3 Ultra as judge; MiniMax for Nemotron Ultra's own write-ups; the next judge takes over if one fails). Score = mean / 5.
4. Reasoning with a known answer (37). Pass = exact.

Quality = the mean of the four task scores (0–1). Latencies are medians over the calls that responded.

| Rank | Model | Quality | Extraction | Tools | Write-up | Reasoning | First token (median) | Total (median) |
|---|---|---|---|---|---|---|---|---|
| 1 | `minimaxai/minimax-m3.1-flash` | 1.000 | 2/2 | 2/2 | 1.00 (5/5, 5/5) | 2/2 | 10.9 s | 14.5 s (write-up 81 s) |
| 2 | `stepfun-ai/step-5-preview` | 0.988 | 2/2 | 2/2 | 0.95 | 2/2 | 1.2 s (0.3–30 s) | 34.6 s (11–116 s) |
| 3 | `moonshotai/kimi-k3.1-pro` | 0.975 | 2/2 | 2/2 | 0.90 | 2/2 | 130 s | 139 s |
| 4 | `mistralai/mistral-large-4-1t-a52b` | 0.750 | 2/2 | 2/2 | 0 (both timed out at 120 s) | 2/2 | 2.3 s | 77 s |
| 5 | `nvidia/nemotron-3.5-super-vl-120b-a12b` | 0.725 | 2/2 | 2/2 | 0.90 | 0/2 (45, 43) | 14.7 s | 16.9 s |
| 6 | `nvidia/nemotron-3-ultra-550b-a55b` | 0.675 | 2/2 | 2/2 | 0.70 (re-judged) | 0/2 (45, 42) | 0.5 s | 3.3 s |

Caveats: there are 8 calls per model, so the ranks 1–3 gap is within noise. In the first pass, Nemotron Ultra's write-ups lost their judge (Mistral timed out) and were re-run with MiniMax judging. Nemotron models ran with thinking disabled (`disable-thinking`), which is how Delegate calls them, and that probably costs them the reasoning task.

**Owner decision: one ranked list for every role, priority rotation with automatic return.** Every role (`planner`, `worker`, `fast`, so the reader, critic, rerank, chat answers and judge too) uses the ranking above: MiniMax M3.1 Flash → Step 5 Preview → Mistral Large 4 → Nemotron 3.5 Super VL → Nemotron 3 Ultra, then Pollinations `openai` (keyless), then the rest as before. `fast` keeps Nemotron 3.5 Lightning after the ranked models; it was not in the bake-off. Kimi ranked third, not top two. It stays `interactive: false` at the head of `planner` and is reached only by max quality mode (below) or `latency: "offline"`.

Rotation mechanics (`router.ts`, tests in `router-rotation.test.ts`):

- `limits.modelRequestsPerMinute` gives each model its own token bucket (NVIDIA: 35 RPM, configurable).
- `limits.scope: "process"` shares buckets, cooldowns and `retry-after` blocks across every run and chat in the server process. Concurrent visitors therefore draw from one budget instead of each believing they have 35 RPM.
- Each call tries the highest-ranked model that is available now. An empty bucket, a 429, a 5xx or a timeout moves the call to the next model at once; there is no queueing. A 429 with `retry-after` blocks that model until the time passes. A 429 without it empties that model's bucket so it refills at the configured rate.
- Nothing is sticky. The next call re-checks from the top, so a refilled or recovered model is used again immediately. `model.fallback` events record each step down for traces; users see no error.

Trade-off: MiniMax's ~11 s first token now applies to high-volume calls too (reader, critic entailment, rerank, chat answers). The previous `fast` head answered in under 0.5 s. This was kept on purpose and is reported to the owner with measured run times.

**Reasoning switch for the primary.** The first live max-quality run (below) showed MiniMax spending all of Build-an-Agent's 3,000-token `evalset` budget on reasoning. Both calls stopped at `max_tokens` without JSON, so `evalset` failed. `src/live/reasoning-switch.live.test.ts` measured one eval-generation prompt:

- MiniMax: default 25.1 s with 2,608 reasoning chars; `reasoning_effort: low` 9.6 s with 0; `disable-thinking` 5.7 s with 0.
- Step 5 Preview ignores both switches: 121 s, 135 s and 152 s, with 2,700–7,900 reasoning chars.

MiniMax now carries `disable-thinking`. A re-run of its bake-off with the switch passed all 7 calls that ran (spec 5 / ground 5 on both write-ups, first token 4–9 s, total 4–18 s). The eighth call got a 429 while a concurrent probe was on the key. Step 5, the backup, has no switch and can take minutes when it is reached.

**Owner decision: NVIDIA serves the public demo.** NVIDIA's `terms` changed from `evaluation-only` to `public-demo-ok`, so the public site uses it when the server has `NVIDIA_API_KEY`. Caveats recorded in `dataPolicy`:

- The NVIDIA API catalog trial terms are for development and evaluation, not production.
- About 40 RPM per key is shared by every visitor; the process-scoped buckets above enforce it.
- Data stays `maxClassification: "public"`.

With no key in the env, the public chain is still keyless-only, and the test for that still holds. The ordering test now requires the entries before the first keyless entry to be keyed free-tier providers (not BYOK). From the first keyless entry on, the order is unchanged.

**Max quality mode.** `RunMissionOptions.quality: "standard" | "max"` (default `standard`; `resumeMission` inherits it). `qualityTimeouts` defaults to 300 s first token and 600 s total.

- Scope: only quality-critical generation steps opt in, via `callStructured({ quality: { say } })`. Those are Build-an-Agent `design`, Automation Audit `rank` (editor) and Company X-ray `synthesise`. In `max`, those calls route `planner` with `latency: "offline"`, so the `interactive: false` head (Kimi) is tried first.
- Long timeouts: they apply only to `interactive: false` entries, through the per-call `StreamOptions.timeouts` that the OpenAI-compatible adapter honours. The router also enforces a first-token deadline itself.
- Fallback: if the head misses the deadline or errors, the router emits `model.fallback` with reason `timeout` (or the error class) and continues down the normal chain, which keeps the provider's normal timeouts.
- Visibility: the step posts one `agent.message`, "Waiting for Kimi K3.1 Pro (max quality, can take several minutes)". `usage.updated` names the model that actually served, and the step summary ends with "Max quality: Kimi K3.1 Pro" only when Kimi served.
- Everything else stays on the fast chain: reader, analysts, critic, rerank, eval generation and grading, chat. So does the repair attempt of a quality-critical structured call.
- Public demo: `public-demo` ignores `max`. The run records why as a planner `agent.message` on the first step. Model IDs live only in config; the label comes from the entry's `displayName`.

**Live check (2026-11-25, owner, `https://umami.is`, robots allows `/` and `ai-input=yes`).** Run 1 completed in 404 s:

- `crawl`: 61 s, 60 pages.
- `index`: 1.7 s.
- `design`: 203.8 s on Kimi K3.1 Pro. The step posted one "Waiting for Kimi K3.1 Pro" message; there was no fallback; the summary reads "… designed · Max quality: Kimi K3.1 Pro".
- `evalset`: failed, because MiniMax used its whole 3,000-token budget on reasoning (two calls). That produced the reasoning switch above.
- `evaluate`: not run. Eval pass rate: n/a.

Run 2, with `disable-thinking` on MiniMax, did not finish within the harness's 25-minute limit. Its events were only written at the end, so the cause is unknown. The harness now streams events to `build-agent-max.events.jsonl` as they arrive. The 25-minute stall is the open risk of a slow backup (Step 5 can take minutes) on a shared key.

### Amendment 3b (2026-11-25): keep live rotation responsive

Step 5 Preview (121–152 s per call, ignores reasoning switches) and Mistral Large 4 (write-up timed out at 120 s) rank 2nd and 4th on quality but break the "invisible to the user" requirement for live calls. Both are marked `interactive: false`: they serve offline and max-quality work only. The live rotation is MiniMax M3.1 Flash → Nemotron 3.5 Super VL → Nemotron 3 Ultra → Nemotron 3.5 Lightning (fast role) → keyless Pollinations, returning to MiniMax as soon as it has capacity.
