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
